import {
  BASE_SEPOLIA_USDC,
  MELLO_CHAIN_ID,
  MELLO_NETWORK,
} from "@mello/shared";
import {
  createPublicClient,
  erc20Abi,
  formatEther,
  formatUnits,
  http,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { safeErrorMessage, writeJson } from "./lib.js";

const HEX_PRIVATE_KEY = /^0x[a-fA-F0-9]{64}$/;

async function main(): Promise<void> {
  const privateKey = process.env["EVM_PRIVATE_KEY"];
  if (!privateKey || !HEX_PRIVATE_KEY.test(privateKey)) {
    throw new Error(
      "EVM_PRIVATE_KEY must be a test-only 32-byte key in the local .env; never paste it into chat or commit it",
    );
  }
  const rpcUrl = process.env["BASE_SEPOLIA_RPC_URL"] ?? "https://sepolia.base.org";
  const token = (process.env["USDC_TOKEN_ADDRESS"] ?? BASE_SEPOLIA_USDC) as Address;
  const minimum = BigInt(process.env["FUND_CHECK_MIN_USDC_ATOMIC"] ?? "150000");
  const account = privateKeyToAccount(privateKey as Hex);
  const client = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl, { timeout: 20_000, retryCount: 2 }),
  });
  const chainId = await client.getChainId();
  if (chainId !== MELLO_CHAIN_ID) {
    throw new Error(`RPC returned chain ${chainId}; expected Base Sepolia ${MELLO_CHAIN_ID}`);
  }
  const [nativeBalance, usdcBalance] = await Promise.all([
    client.getBalance({ address: account.address }),
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    }),
  ]);
  const sufficient = usdcBalance >= minimum;
  writeJson({
    network: MELLO_NETWORK,
    chainId,
    walletAddress: account.address,
    nativeEth: formatEther(nativeBalance),
    testUsdc: formatUnits(usdcBalance, 6),
    testUsdcAtomic: usdcBalance.toString(),
    minimumTestUsdcAtomic: minimum.toString(),
    sufficient,
    testnetOnly: true,
  });
  if (!sufficient) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(`Fund check failed: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
