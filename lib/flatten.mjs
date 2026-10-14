// Bake form fields and markup into page content. MuPDF keeps a stale widget
// list on the live page objects until the file is written and opened again,
// so callers that keep editing should reopen the saved bytes.

export function flattenDocument(doc, { annotations = true, forms = true } = {}) {
  const bakeAnnots = !!annotations;
  const bakeForms = !!forms;
  if (!bakeAnnots && !bakeForms) return { flattened: false, annotations: false, forms: false };
  doc.bake(bakeAnnots, bakeForms);
  return { flattened: true, annotations: bakeAnnots, forms: bakeForms };
}
