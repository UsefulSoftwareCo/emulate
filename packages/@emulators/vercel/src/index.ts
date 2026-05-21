export const serviceName = "vercel";
export const serviceLabel = "Vercel REST API";
export const runtime = "native-go";

export const service = {
  name: serviceName,
  label: serviceLabel,
  runtime,
} as const;

export default service;
