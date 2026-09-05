import { DocumentPage } from "../components/document-page";
import { documents } from "../content/documents";

export default function Overview() {
  return <DocumentPage document={documents[0]} />;
}
