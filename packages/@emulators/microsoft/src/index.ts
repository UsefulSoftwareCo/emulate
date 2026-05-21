export const serviceName = "microsoft";
export const serviceLabel = "Microsoft Entra ID and Graph";
export const runtime = "native-go";

export const service = {
  name: serviceName,
  label: serviceLabel,
  runtime,
} as const;

export default service;
