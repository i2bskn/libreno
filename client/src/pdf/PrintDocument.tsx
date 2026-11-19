import { Markdown } from "../Markdown";

// "formal" starts with a cover page; "simple" starts the body with the title.
export type PrintVariant = "formal" | "simple";

export type PrintFields = {
  variant: PrintVariant;
  title: string;
  // The fields below are printed on the cover only ("formal"), except confidentiality, which is also in the top
  // right of every page (see css.ts). Empty ones are left out.
  recipient: string;
  date: string;
  version: string;
  issuer: string;
  confidentiality: string;
};

// The document that becomes the PDF. Its look comes only from client/public/print-document.css, so that the
// preview, the print dialog and the server render it the same. Every value is text, never HTML.
export function PrintDocument({ fields, body, origin }: { fields: PrintFields; body: string; origin: string }) {
  return (
    <div className="print-doc" data-variant={fields.variant}>
      {fields.variant === "formal" ? <Cover fields={fields} /> : <h1 className="print-title">{fields.title}</h1>}
      <main className="print-body">
        <Markdown body={body} origin={origin} />
      </main>
    </div>
  );
}

function Cover({ fields }: { fields: PrintFields }) {
  const confidentiality = fields.confidentiality.trim();
  const recipient = fields.recipient.trim();
  const meta = [
    { label: "日付", value: fields.date.trim() },
    { label: "版数", value: fields.version.trim() },
    { label: "発行者", value: fields.issuer.trim() },
  ].filter((item) => item.value !== "");
  return (
    <section className="print-cover">
      {confidentiality !== "" && <p className="print-cover-confidential">{confidentiality}</p>}
      {recipient !== "" && <p className="print-cover-recipient">{recipient}</p>}
      <h1 className="print-cover-title">{fields.title}</h1>
      {meta.length > 0 && (
        <dl className="print-cover-meta">
          {meta.map((item) => (
            <div key={item.label}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
