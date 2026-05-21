export const serviceName = "clerk";
export const serviceLabel = "Clerk authentication and user management";
export const runtime = "native-go";

export const service = {
  name: serviceName,
  label: serviceLabel,
  runtime,
} as const;

export default service;
