import { useMemo, useRef, useState } from "react";
import type { Page, PdfRenderer, PdfSettings } from "../../../src/api/types";
import { pdfFilename } from "../../../src/pdf/filename";
import { PDF_FAILED_MESSAGE, downloadPagePdf, savePdfSettings } from "../actions";
import { Link } from "../Link";
import { type ApiClient, loadPagePdf, useView } from "../load";
import { buildDynamicCss } from "../pdf/css";
import { PrintDocument, type PrintFields, type PrintVariant } from "../pdf/PrintDocument";
import { PrintFrame, type PrintStyleStatus } from "../pdf/PrintFrame";
import { buildPdfHtml, fetchPrintCss, serializePrintDocument } from "../pdf/serialize";
import { useSidebarLocation, viewLocation } from "../sidebarStore";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";

const FIELD_MAX_LENGTH = 100;
// The same as the longest title of a page.
const TITLE_MAX_LENGTH = 200;

const VARIANTS: readonly { value: PrintVariant; label: string }[] = [
  { value: "formal", label: "正式（表紙あり）" },
  { value: "simple", label: "シンプル" },
];

const PRINT_NOTE =
  "印刷ダイアログの送信先で『PDFに保存』を選び、『ヘッダーとフッター』のチェックを外してください。ページ番号と機密表示のヘッダーはChromeでのみ入ります";

// How long the URL of a downloaded PDF is kept: revoking it right after the click can cancel the download in some
// browsers.
const REVOKE_AFTER_MS = 60_000;

// Today as 2026年1月2日, the default date on the cover. It is a text field, so any form can be typed instead.
function todayLabel(now = new Date()): string {
  return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
}

export function PagePdfView({
  client,
  id,
  origin,
  isAdmin,
}: {
  client: ApiClient;
  id: string;
  origin: string;
  isAdmin: boolean;
}) {
  const [state, reload] = useView(() => loadPagePdf(client, id), id);
  useDocumentTitle(viewTitle(state, (data) => `PDFで出力: ${data.page.title}`));
  useSidebarLocation(
    viewLocation(state, ({ page }) => ({
      spaceId: page.space_id,
      folderId: page.folder_id,
      pageId: page.id,
      current: "location",
    })),
  );

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="ページが見つかりません" onReload={reload} />;
  }
  // Keyed by the page, so that the fields start again from the defaults of another page.
  return (
    <PdfOutput
      key={state.data.page.id}
      client={client}
      id={id}
      origin={origin}
      isAdmin={isAdmin}
      page={state.data.page}
      settings={state.data.settings}
    />
  );
}

type ActionState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string }
  // The move to the login page has started; the button stays disabled.
  | { kind: "redirecting" };

function PdfOutput({
  client,
  id,
  origin,
  isAdmin,
  page,
  settings,
}: {
  client: ApiClient;
  id: string;
  origin: string;
  isAdmin: boolean;
  page: Page;
  settings: PdfSettings | null;
}) {
  // The fields are kept only on this screen; only the issuer and the confidentiality label can be saved, as defaults.
  const [fields, setFields] = useState<PrintFields>(() => ({
    variant: "formal",
    title: page.title,
    recipient: "",
    date: todayLabel(),
    version: "",
    issuer: settings?.issuer ?? "",
    confidentiality: settings?.confidentiality ?? "",
  }));
  const [styleStatus, setStyleStatus] = useState<PrintStyleStatus>("loading");
  const [output, setOutput] = useState<ActionState>({ kind: "idle" });
  const [save, setSave] = useState<ActionState>({ kind: "idle" });
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // Without the settings, the print dialog is the one way that always works.
  const renderer: PdfRenderer = settings?.renderer ?? "print";
  const formal = fields.variant === "formal";
  const dynamicCss = useMemo(
    () => buildDynamicCss({ confidentiality: fields.confidentiality, hasCover: formal }),
    [fields.confidentiality, formal],
  );

  function setField<K extends keyof PrintFields>(key: K, value: PrintFields[K]): void {
    setFields((current) => ({ ...current, [key]: value }));
  }

  const sending = output.kind === "sending" || output.kind === "redirecting";
  const outputDisabled = styleStatus !== "ready" || sending;

  function onPrint(): void {
    frameRef.current?.contentWindow?.print();
  }

  async function onDownload(): Promise<void> {
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    setOutput({ kind: "sending" });
    const [bodyHtml, css] = await Promise.all([serializePrintDocument(doc, origin), fetchPrintCss()]);
    if (bodyHtml === null || css === null) {
      setOutput({ kind: "error", message: PDF_FAILED_MESSAGE });
      return;
    }
    const html = buildPdfHtml({ title: fields.title, css, dynamicCss, bodyHtml });
    const result = await downloadPagePdf(client, id, html);
    switch (result.kind) {
      case "ok": {
        const url = URL.createObjectURL(result.pdf);
        const link = document.createElement("a");
        link.href = url;
        link.download = pdfFilename(fields.title);
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
        setOutput({ kind: "idle" });
        return;
      }
      case "error":
        setOutput({ kind: "error", message: result.message });
        return;
      case "redirecting":
        setOutput({ kind: "redirecting" });
        return;
    }
  }

  async function onSaveDefaults(): Promise<void> {
    setSave({ kind: "sending" });
    const result = await savePdfSettings(client, { issuer: fields.issuer, confidentiality: fields.confidentiality });
    switch (result.kind) {
      case "ok":
        setSave({ kind: "done", message: "既定として保存しました" });
        return;
      case "error":
        setSave({ kind: "error", message: result.message });
        return;
      case "unknown":
        setSave({
          kind: "error",
          message: "サーバーに接続できませんでした。画面を開き直して、保存されているか確かめてください",
        });
        return;
      case "redirecting":
        setSave({ kind: "redirecting" });
        return;
    }
  }

  return (
    <main className="main pdf-view">
      <p className="pdf-back">
        <Link to={`/pages/${id}`}>「{page.title}」に戻る</Link>
      </p>
      <h1>PDFで出力</h1>
      <div className="pdf-layout">
        <form className="pdf-form" aria-label="PDFの設定" onSubmit={(event) => event.preventDefault()}>
          <fieldset className="pdf-variants">
            <legend>体裁</legend>
            {VARIANTS.map(({ value, label }) => (
              <label key={value} className="pdf-variant">
                <input
                  type="radio"
                  name="variant"
                  value={value}
                  checked={fields.variant === value}
                  onChange={() => setField("variant", value)}
                />
                {label}
              </label>
            ))}
          </fieldset>
          <label>
            タイトル
            <input
              type="text"
              value={fields.title}
              maxLength={TITLE_MAX_LENGTH}
              onChange={(event) => setField("title", event.target.value)}
            />
          </label>
          {formal && (
            <>
              <label>
                宛先
                <input
                  type="text"
                  value={fields.recipient}
                  maxLength={FIELD_MAX_LENGTH}
                  placeholder="株式会社〇〇 御中"
                  onChange={(event) => setField("recipient", event.target.value)}
                />
              </label>
              <label>
                日付
                <input
                  type="text"
                  value={fields.date}
                  maxLength={FIELD_MAX_LENGTH}
                  onChange={(event) => setField("date", event.target.value)}
                />
              </label>
              <label>
                版数
                <input
                  type="text"
                  value={fields.version}
                  maxLength={FIELD_MAX_LENGTH}
                  placeholder="1.0"
                  onChange={(event) => setField("version", event.target.value)}
                />
              </label>
              <label>
                発行者
                <input
                  type="text"
                  value={fields.issuer}
                  maxLength={FIELD_MAX_LENGTH}
                  onChange={(event) => setField("issuer", event.target.value)}
                />
              </label>
            </>
          )}
          <label>
            機密表示
            <input
              type="text"
              value={fields.confidentiality}
              maxLength={FIELD_MAX_LENGTH}
              placeholder="社外秘"
              onChange={(event) => setField("confidentiality", event.target.value)}
            />
          </label>
          {/* Shown only to admins; the server checks it again. */}
          {isAdmin && (
            <div className="pdf-defaults">
              <button
                type="button"
                onClick={() => void onSaveDefaults()}
                disabled={save.kind === "sending" || save.kind === "redirecting"}
              >
                発行者と機密表示を既定として保存
              </button>
              {save.kind === "done" && (
                <p className="pdf-status" role="status">
                  {save.message}
                </p>
              )}
              {save.kind === "error" && <p role="alert">{save.message}</p>}
            </div>
          )}
          <div className="pdf-actions">
            {renderer === "server" ? (
              <>
                <button
                  type="button"
                  className="button-primary"
                  onClick={() => void onDownload()}
                  disabled={outputDisabled}
                >
                  {sending ? "作成中…" : "PDFをダウンロード"}
                </button>
                <button type="button" onClick={onPrint} disabled={outputDisabled}>
                  ブラウザで印刷
                </button>
                <p className="form-hint pdf-note">{PRINT_NOTE}</p>
              </>
            ) : (
              <>
                <button type="button" className="button-primary" onClick={onPrint} disabled={outputDisabled}>
                  印刷 / PDFに保存
                </button>
                <p className="form-hint">{PRINT_NOTE}</p>
              </>
            )}
            {styleStatus === "error" && <p role="alert">印刷用のスタイルを読み込めませんでした</p>}
            {output.kind === "error" && <p role="alert">{output.message}</p>}
          </div>
        </form>
        <section className="pdf-preview" aria-label="プレビュー">
          <PrintFrame frameRef={frameRef} title={fields.title} dynamicCss={dynamicCss} onStyleStatus={setStyleStatus}>
            <PrintDocument fields={fields} body={page.body} origin={origin} />
          </PrintFrame>
        </section>
      </div>
    </main>
  );
}
