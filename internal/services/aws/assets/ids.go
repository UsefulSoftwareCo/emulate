package assets

import (
	"net/url"
	"strings"
)

const (
	PurposeS3Object               = "aws.s3.object"
	PurposeLambdaPackage          = "aws.lambda.package"
	PurposeLambdaLayer            = "aws.lambda.layer"
	PurposeCloudFormationTemplate = "aws.cloudformation.template"
)

func S3ObjectID(bucket string, key string) string {
	return join("aws", "s3", "buckets", bucket, "objects", key)
}

func LambdaPackageID(functionName string, revision string) string {
	return join("aws", "lambda", "functions", functionName, "packages", revision)
}

func LambdaLayerID(layerName string, version string) string {
	return join("aws", "lambda", "layers", layerName, "versions", version)
}

func CloudFormationTemplateID(stackName string, templateID string) string {
	return join("aws", "cloudformation", "stacks", stackName, "templates", templateID)
}

func join(parts ...string) string {
	escaped := make([]string, 0, len(parts))
	for _, part := range parts {
		escaped = append(escaped, url.PathEscape(part))
	}
	return strings.Join(escaped, "/")
}
