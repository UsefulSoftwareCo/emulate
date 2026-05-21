export const serviceName = "okta";
export const serviceLabel = "Okta identity and management APIs";
export const runtime = "native-go";

export const service = {
  name: serviceName,
  label: serviceLabel,
  runtime,
} as const;

export default service;
