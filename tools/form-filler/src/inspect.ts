// Blank-PDF inspection: is it a fillable AcroForm or a flat/scanned PDF, and
// what fields does it have? (Pure XFA/LiveCycle forms report zero AcroForm
// fields — pdf-lib cannot fill those; they need the overlay path or a human.)
import {
  PDFDocument,
  PDFCheckBox,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
} from "pdf-lib";

export interface InspectedField {
  name: string;
  type: "text" | "checkbox" | "dropdown" | "optionlist" | "radio" | "other";
  options?: string[];
  maxLength?: number;
}

export interface PdfInspection {
  pageCount: number;
  pageSizes: { width: number; height: number }[];
  /** False for flat/scanned/XFA PDFs — those need an overlay map. */
  hasAcroFields: boolean;
  fields: InspectedField[];
}

export async function inspectPdf(bytes: Uint8Array): Promise<PdfInspection> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pageSizes = doc.getPages().map((p) => {
    const { width, height } = p.getSize();
    return { width, height };
  });
  const fields: InspectedField[] = doc.getForm().getFields().map((f) => {
    if (f instanceof PDFTextField) {
      const maxLength = f.getMaxLength();
      return { name: f.getName(), type: "text" as const, ...(maxLength != null ? { maxLength } : {}) };
    }
    if (f instanceof PDFCheckBox) return { name: f.getName(), type: "checkbox" as const };
    if (f instanceof PDFDropdown) return { name: f.getName(), type: "dropdown" as const, options: f.getOptions() };
    if (f instanceof PDFOptionList) return { name: f.getName(), type: "optionlist" as const, options: f.getOptions() };
    if (f instanceof PDFRadioGroup) return { name: f.getName(), type: "radio" as const, options: f.getOptions() };
    return { name: f.getName(), type: "other" as const };
  });
  return {
    pageCount: pageSizes.length,
    pageSizes,
    hasAcroFields: fields.some((f) => f.type !== "other"),
    fields,
  };
}
