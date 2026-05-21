export const serviceName = "resend";
export const serviceLabel = "Resend email API";
export const runtime = "native-go";

export const service = {
  name: serviceName,
  label: serviceLabel,
  runtime,
} as const;

export default service;
