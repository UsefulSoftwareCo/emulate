export const serviceName = "google";
export const serviceLabel = "Google OAuth, Gmail, Calendar, and Drive";
export const runtime = "native-go";

export const service = {
  name: serviceName,
  label: serviceLabel,
  runtime,
} as const;

export default service;
