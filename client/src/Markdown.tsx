import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

const remarkPlugins = [remarkGfm];

// Colors code blocks that name a language, with hljs-* classes only (no style attributes, which the CSP blocks).
const rehypePlugins = [rehypeHighlight];

const remarkRehypeOptions = { footnoteLabel: "脚注", footnoteBackLabel: "本文に戻る" };

// Whether href leads to another site. Links that cannot be parsed are not external, and are drawn as they are.
export function isExternalLink(href: string | undefined, origin: string): boolean {
  if (href === undefined) return false;
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && url.origin !== origin;
}

// Renders a page body. Raw HTML in the Markdown is shown as text, not as elements (react-markdown's
// default without rehype-raw), and dangerous URLs such as javascript: are emptied by its default urlTransform.
// origin is the current origin, used to tell external links.
export function Markdown({ body, origin }: { body: string; origin: string }) {
  // node is the hast node react-markdown passes to components; it must not reach the DOM.
  const components: Components = {
    a({ node: _node, ...props }) {
      if (!isExternalLink(props.href, origin)) return <a {...props} />;
      return <a {...props} target="_blank" rel="noopener noreferrer" />;
    },
    // Wide tables scroll inside the wrapper instead of the page.
    table({ node: _node, ...props }) {
      return (
        <div className="table-wrap">
          <table {...props} />
        </div>
      );
    },
  };

  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        remarkRehypeOptions={remarkRehypeOptions}
        components={components}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
