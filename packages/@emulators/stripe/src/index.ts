export const serviceName = "stripe";
export const serviceLabel = "Stripe billing and payments API";
export const runtime = "native-go";

export const service = {
  name: serviceName,
  label: serviceLabel,
  runtime,
} as const;

export default service;
