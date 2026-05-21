export const serviceName = "apple";
export const serviceLabel = "Apple Sign In / OIDC";
export const runtime = "native-go";

export const service = {
  name: serviceName,
  label: serviceLabel,
  runtime,
} as const;

export default service;
