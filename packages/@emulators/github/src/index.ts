export const serviceName = "github";
export const serviceLabel = "GitHub REST, OAuth, and webhooks";
export const runtime = "native-go";

export const service = {
  name: serviceName,
  label: serviceLabel,
  runtime,
} as const;

export default service;
