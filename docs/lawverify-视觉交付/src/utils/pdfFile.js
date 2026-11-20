export function pdfFileUrl(file) {
  return URL.createObjectURL(new Blob([file], { type: 'application/pdf' }));
}
