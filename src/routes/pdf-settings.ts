import { Hono } from "hono";
import type { PdfSettings, UpdatePdfSettingsRequest } from "../api/types";
import type { AppEnv } from "../env";
import { apiError } from "@i2bskn/workers-app-core";
import { core } from "../core";
import { resolvePdfRenderer } from "../pdf/renderer";
import {
  getPdfSettings,
  invalidPdfSettingsMessage,
  normalizePdfSettingValue,
  savePdfSettings,
  type PdfSettingsRow,
} from "../pdf/settings";
import { jsonBody } from "./api";

const { requireAdmin, requireUser } = core.middleware;

// Both keys are required, so that a client that sends only one does not clear the other by mistake.
const updatePdfSettingsBody = jsonBody<UpdatePdfSettingsRequest, PdfSettingsRow, AppEnv>((body, c) => {
  const issuer = normalizePdfSettingValue(body.issuer);
  const confidentiality = normalizePdfSettingValue(body.confidentiality);
  if (!issuer.ok || !confidentiality.ok) {
    return apiError(c, 400, "invalid_pdf_settings", invalidPdfSettingsMessage);
  }
  return { ok: true, value: { issuer: issuer.value, confidentiality: confidentiality.value } };
});

const pdfSettingsApi = new Hono<AppEnv>()
  .get("/", requireUser, async (c) => {
    const settings = await getPdfSettings(c.get("db"));
    const body: PdfSettings = { renderer: resolvePdfRenderer(c.env), ...settings };
    return c.json(body, 200);
  })
  .put("/", requireUser, requireAdmin, updatePdfSettingsBody, async (c) => {
    const settings = await savePdfSettings(c.get("db"), c.get("user"), c.req.valid("json"));
    const body: PdfSettings = { renderer: resolvePdfRenderer(c.env), ...settings };
    return c.json(body, 200);
  });

export default pdfSettingsApi;
