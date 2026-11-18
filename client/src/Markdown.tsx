import { type ComponentProps, useEffect, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { CheckIcon, CopyIcon } from "./icons";

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
    pre({ node: _node, ...props }) {
      return <CodeBlock {...props} />;
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

type CodeCopyState = "idle" | "copied" | "failed";

const CODE_COPY_LABELS: Record<CodeCopyState, string> = {
  idle: "コードをコピー",
  copied: "コピーしました",
  failed: "コピーできませんでした。選択されたコードをコピーしてください",
};

// How long the check mark stays after copying, as on the toolbar of a page.
const CODE_COPIED_MS = 2000;

// A code block with a button that copies its code. The button sits outside the pre, so that it stays in the corner
// while the code scrolls sideways. It has no text of its own (its name is the aria-label), so the text of the page
// body copied from the toolbar does not get it.
function CodeBlock(props: ComponentProps<"pre">) {
  const pre = useRef<HTMLPreElement>(null);
  const [state, setState] = useState<CodeCopyState>("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), CODE_COPIED_MS);
    return () => clearTimeout(timer);
  }, [state]);

  // The code is read from the DOM on click, so the highlighting spans need not be taken apart. The newline that
  // ends every code block is not part of the code.
  async function copy(): Promise<void> {
    const element = pre.current;
    if (element === null) return;
    setState("idle");
    try {
      if (typeof navigator.clipboard?.writeText !== "function") throw new Error("no clipboard API");
      await navigator.clipboard.writeText((element.textContent ?? "").replace(/\n$/, ""));
      setState("copied");
    } catch {
      // The clipboard API is missing outside secure contexts and can reject; then the code is selected to be
      // copied with the keyboard or the menu.
      window.getSelection()?.selectAllChildren(element);
      setState("failed");
    }
  }

  const label = CODE_COPY_LABELS[state];
  return (
    <div className="code-block">
      <pre ref={pre} {...props} />
      <button type="button" className="code-copy-button" aria-label={label} title={label} onClick={() => void copy()}>
        {state === "copied" ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  );
}
