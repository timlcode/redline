// Certificate signing (a PKCS#7 byte range over the file) is intentionally not
// implemented. Visual signatures are appearances only. Install a signer later
// with setDigitalSigner; until then signWithCertificate refuses.
import { httpError } from "./pdf.mjs";

let signer = null;

/** @param {((request: object) => any) | null} fn */
export function setDigitalSigner(fn) {
  signer = typeof fn === "function" ? fn : null;
}

export function hasDigitalSigner() {
  return signer !== null;
}

/**
 * Hand a signature field to the installed certificate signer.
 * `found` is the field record from listFields (includes the live widget).
 * The default signer is not installed, so this refuses.
 */
export function signWithCertificate(found) {
  if (!found) throw httpError(404, "Field not found");
  if (found.type !== "signature") throw httpError(400, "That field is not a signature field");
  if (!signer) {
    const e = httpError(501, "Certificate signing is not available");
    e.code = "digital-signature-unavailable";
    throw e;
  }
  return signer({
    fieldId: found.id,
    pageIndex: found.page,
    name: found.name,
    widget: found.widget,
  });
}
