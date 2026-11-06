export function previewRecordCount(totalRecords: number, maximumPreviewRecords = 4): number {
  if (!Number.isFinite(totalRecords) || totalRecords <= 0) return 0;
  return Math.min(Math.floor(totalRecords), Math.max(0, Math.floor(maximumPreviewRecords)));
}
