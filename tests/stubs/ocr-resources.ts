/** Stand-in for esbuild's `virtual:ocr-resources` (OCR's embedded files). */
export default function ocrResource(_name: string): string | undefined {
    return undefined;
}
