import { notFound } from "next/navigation";
import { DocumentPage } from "../../components/document-page";
import { documents } from "../../content/documents";

export const dynamicParams = false;
export function generateStaticParams() {
  return documents.filter((doc) => doc.slug).map((doc) => ({ slug: doc.slug }));
}
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return {
    title: documents.find((doc) => doc.slug === slug)?.title ?? "找不到文件",
  };
}
export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const document = documents.find((doc) => doc.slug === slug);
  if (!document) notFound();
  return <DocumentPage document={document} />;
}
