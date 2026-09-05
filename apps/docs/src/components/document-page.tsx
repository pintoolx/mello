import Link from "next/link";
import { documents, type Document } from "../content/documents";

export function DocumentPage({ document }: { document: Document }) {
  const groups = [...new Set(documents.map((doc) => doc.group))];
  const index = documents.findIndex((doc) => doc.slug === document.slug);
  const previous = documents[index - 1];
  const next = documents[index + 1];
  const menu = (
    <>
      {groups.map((group) => (
        <div className="doc-nav-group" key={group}>
          <p>{group}</p>
          {documents
            .filter((doc) => doc.group === group)
            .map((doc) => (
              <Link
                key={doc.slug}
                href={`/${doc.slug}`}
                aria-current={doc.slug === document.slug ? "page" : undefined}
              >
                {doc.title}
              </Link>
            ))}
        </div>
      ))}
    </>
  );
  return (
    <>
      <a className="skip-link" href="#document">
        跳至文件內容
      </a>
      <header className="docs-header">
        <Link href="/" className="docs-brand" aria-label="Mello 文件">
          <img className="docs-mark" src="/brand/mello-mark.svg" alt="" width={30} height={26} />
          <span>文件</span>
        </Link>
        <span className="docs-edition">產品與技術文件</span>
      </header>
      <div className="docs-layout">
        <aside className="docs-sidebar">
          <div className="docs-caption">DOCUMENTATION</div>
          <nav aria-label="文件目錄">{menu}</nav>
          <div className="docs-sidebar-note">
            企業代理採購
            <br />
            Purchase-to-Pay
          </div>
        </aside>
        <div className="mobile-doc-nav">
          <details>
            <summary>
              文件目錄 <span>{document.title}</span>
            </summary>
            <nav aria-label="行動版文件目錄">{menu}</nav>
          </details>
        </div>
        <main id="document" className="document">
          <div className="doc-breadcrumb">
            文件 <span>/</span> {document.group}
          </div>
          <header className="doc-heading">
            <h1>{document.title}</h1>
            <p>{document.description}</p>
          </header>
          <div className="mobile-toc">
            <details>
              <summary>本頁內容</summary>
              {document.sections.map((section) => (
                <a href={`#${section.id}`} key={section.id}>
                  {section.title}
                </a>
              ))}
            </details>
          </div>
          {document.sections.map((section) => (
            <section className="doc-section" id={section.id} key={section.id}>
              <h2>{section.title}</h2>
              {section.content}
            </section>
          ))}
          <nav className="doc-pagination" aria-label="相鄰文件">
            {previous ? (
              <Link href={`/${previous.slug}`}>
                <small>← 上一篇</small>
                <span>{previous.title}</span>
              </Link>
            ) : (
              <span />
            )}
            {next && (
              <Link href={`/${next.slug}`}>
                <small>下一篇 →</small>
                <span>{next.title}</span>
              </Link>
            )}
          </nav>
          <footer className="doc-footer">
            Mello 文件 · 內容以目前實作範圍為準。
          </footer>
        </main>
        <aside className="docs-toc">
          <span>本頁內容</span>
          <nav aria-label="本頁章節">
            {document.sections.map((section) => (
              <a href={`#${section.id}`} key={section.id}>
                {section.title}
              </a>
            ))}
          </nav>
        </aside>
      </div>
    </>
  );
}
