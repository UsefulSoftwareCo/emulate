export const serviceName = "slack";
export const serviceLabel = "Slack Web API, OAuth, and webhooks";
export const runtime = "native-go";

export const service = {
  name: serviceName,
  label: serviceLabel,
  runtime,
} as const;

export default service;
