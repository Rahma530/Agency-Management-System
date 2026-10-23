export const isCurrentReportDetailsRequest = (
  requestReportId: string,
  selectedReportId: string,
  requestToken: number,
  currentToken: number,
): boolean => requestReportId === selectedReportId && requestToken === currentToken;

export const isReportDetailsReady = (
  selectedReportId: string,
  loadedReportId: string | null,
  isLoading: boolean,
  error: string | null,
): boolean => !!selectedReportId
  && loadedReportId === selectedReportId
  && !isLoading
  && !error;

export const isReportVersionForSelection = (
  version: { report_id: string } | null,
  selectedReportId: string,
): boolean => !!version && !!selectedReportId && version.report_id === selectedReportId;
