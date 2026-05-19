package sqs

import (
	"crypto/md5"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/services/aws/gateway"
	"github.com/vercel-labs/emulate/internal/services/aws/protocols"
)

type Handler struct {
	Queues           *corestore.Collection
	Messages         *corestore.Collection
	BaseURL          string
	AccountID        string
	Region           string
	Now              func() time.Time
	IDGenerator      func() string
	ReceiptGenerator func() string
}

var fallbackIDCounter atomic.Uint64

func (h *Handler) Handle(req *http.Request, ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	if ctx.Protocol == protocols.ProtocolJSONRPC {
		return h.handleJSON(req, ctx)
	}
	requestID := ctx.RequestID
	if requestID == "" {
		requestID = h.generateID()
	}
	var response protocols.ErrorResponse
	switch ctx.Action {
	case "CreateQueue":
		response = h.createQueue(req, ctx.Query, requestID)
	case "DeleteQueue":
		response = h.deleteQueue(ctx.Query, requestID)
	case "ListQueues":
		response = h.listQueues(ctx.Query, requestID)
	case "GetQueueUrl":
		response = h.getQueueURL(ctx.Query, requestID)
	case "GetQueueAttributes":
		response = h.getQueueAttributes(ctx.Query, requestID)
	case "SendMessage":
		response = h.sendMessage(ctx.Query, requestID)
	case "ReceiveMessage":
		response = h.receiveMessage(ctx.Query, requestID)
	case "DeleteMessage":
		response = h.deleteMessage(ctx.Query, requestID)
	case "PurgeQueue":
		response = h.purgeQueue(ctx.Query, requestID)
	default:
		action := ctx.Action
		response = h.queryError("InvalidAction", "The action "+action+" is not valid for this endpoint.", http.StatusBadRequest, requestID)
	}
	return withRequestID(response, requestID)
}

func (h *Handler) handleJSON(req *http.Request, ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	requestID := ctx.RequestID
	if requestID == "" {
		requestID = h.generateID()
	}
	params := jsonParams(ctx.Input)
	var response protocols.ErrorResponse
	switch ctx.Action {
	case "CreateQueue":
		response = h.createQueueJSON(req, params)
	case "DeleteQueue":
		response = h.deleteQueueJSON(params)
	case "ListQueues":
		response = h.listQueuesJSON(params)
	case "GetQueueUrl":
		response = h.getQueueURLJSON(params)
	case "GetQueueAttributes":
		response = h.getQueueAttributesJSON(params)
	case "SendMessage":
		response = h.sendMessageJSON(params)
	case "ReceiveMessage":
		response = h.receiveMessageJSON(params)
	case "DeleteMessage":
		response = h.deleteMessageJSON(params)
	case "PurgeQueue":
		response = h.purgeQueueJSON(params)
	default:
		response = jsonResponse(http.StatusBadRequest, map[string]any{"__type": "InvalidAction", "message": "The action " + ctx.Action + " is not valid for this endpoint."})
	}
	return withRequestID(response, requestID)
}

func (h *Handler) createQueue(req *http.Request, params map[string]string, requestID string) protocols.ErrorResponse {
	queueName := params["QueueName"]
	if queueName == "" {
		return h.queryError("MissingParameter", "The request must contain the parameter QueueName.", http.StatusBadRequest, requestID)
	}
	if existing, ok := h.findQueueByName(queueName); ok {
		return h.queueURLResponse("CreateQueue", stringField(existing, "queue_url"), requestID)
	}
	attrs := indexedAttributes(params, "Attribute")
	region := h.region()
	accountID := h.accountID()
	queueURL := strings.TrimRight(h.baseURL(req), "/") + "/sqs/" + accountID + "/" + queueName
	queue := h.Queues.Insert(corestore.Record{
		"queue_name":                queueName,
		"queue_url":                 queueURL,
		"arn":                       "arn:aws:sqs:" + region + ":" + accountID + ":" + queueName,
		"visibility_timeout":        intParam(attrs["VisibilityTimeout"], 30),
		"delay_seconds":             intParam(attrs["DelaySeconds"], 0),
		"max_message_size":          intParam(attrs["MaximumMessageSize"], 262144),
		"message_retention_period":  intParam(attrs["MessageRetentionPeriod"], 345600),
		"receive_message_wait_time": intParam(attrs["ReceiveMessageWaitTimeSeconds"], 0),
		"fifo":                      strings.HasSuffix(queueName, ".fifo"),
	})
	return h.queueURLResponse("CreateQueue", stringField(queue, "queue_url"), requestID)
}

func (h *Handler) deleteQueue(params map[string]string, requestID string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFound(requestID)
	}
	for _, message := range h.Messages.FindBy("queue_name", stringField(queue, "queue_name")) {
		h.Messages.Delete(intField(message, "id"))
	}
	h.Queues.Delete(intField(queue, "id"))
	body := `<?xml version="1.0" encoding="UTF-8"?>
<DeleteQueueResponse>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</DeleteQueueResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) listQueues(params map[string]string, requestID string) protocols.ErrorResponse {
	prefix := params["QueueNamePrefix"]
	var rows strings.Builder
	for _, queue := range h.Queues.All() {
		if prefix != "" && !strings.HasPrefix(stringField(queue, "queue_name"), prefix) {
			continue
		}
		rows.WriteString(`    <QueueUrl>`)
		rows.WriteString(xmlEscape(stringField(queue, "queue_url")))
		rows.WriteString(`</QueueUrl>
`)
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<ListQueuesResponse>
  <ListQueuesResult>
` + strings.TrimRight(rows.String(), "\n") + `
  </ListQueuesResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</ListQueuesResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) getQueueURL(params map[string]string, requestID string) protocols.ErrorResponse {
	queue, ok := h.findQueueByName(params["QueueName"])
	if !ok {
		return h.queueNotFound(requestID)
	}
	return h.queueURLResponse("GetQueueUrl", stringField(queue, "queue_url"), requestID)
}

func (h *Handler) getQueueAttributes(params map[string]string, requestID string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFound(requestID)
	}
	now := h.nowMillis()
	visibleCount := 0
	inFlightCount := 0
	for _, message := range h.Messages.FindBy("queue_name", stringField(queue, "queue_name")) {
		if int64Field(message, "visible_after") <= now {
			visibleCount++
		} else {
			inFlightCount++
		}
	}
	attrs := []nameValue{
		{"QueueArn", stringField(queue, "arn")},
		{"ApproximateNumberOfMessages", strconv.Itoa(visibleCount)},
		{"ApproximateNumberOfMessagesNotVisible", strconv.Itoa(inFlightCount)},
		{"VisibilityTimeout", strconv.Itoa(intField(queue, "visibility_timeout"))},
		{"MaximumMessageSize", strconv.Itoa(intField(queue, "max_message_size"))},
		{"MessageRetentionPeriod", strconv.Itoa(intField(queue, "message_retention_period"))},
		{"DelaySeconds", strconv.Itoa(intField(queue, "delay_seconds"))},
		{"ReceiveMessageWaitTimeSeconds", strconv.Itoa(intField(queue, "receive_message_wait_time"))},
		{"FifoQueue", strconv.FormatBool(boolField(queue, "fifo"))},
	}
	var rows strings.Builder
	for _, attr := range attrs {
		rows.WriteString(`    <Attribute><Name>`)
		rows.WriteString(xmlEscape(attr.Name))
		rows.WriteString(`</Name><Value>`)
		rows.WriteString(xmlEscape(attr.Value))
		rows.WriteString(`</Value></Attribute>
`)
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<GetQueueAttributesResponse>
  <GetQueueAttributesResult>
` + strings.TrimRight(rows.String(), "\n") + `
  </GetQueueAttributesResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</GetQueueAttributesResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) sendMessage(params map[string]string, requestID string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFound(requestID)
	}
	messageBody := params["MessageBody"]
	if messageBody == "" {
		return h.queryError("MissingParameter", "The request must contain the parameter MessageBody.", http.StatusBadRequest, requestID)
	}
	if len([]byte(messageBody)) > intField(queue, "max_message_size") {
		return h.queryError("InvalidParameterValue", "One or more parameters are invalid. Reason: Message must be shorter than "+strconv.Itoa(intField(queue, "max_message_size"))+" bytes.", http.StatusBadRequest, requestID)
	}
	messageID := h.generateID()
	bodyMD5 := md5Hex(messageBody)
	now := h.nowMillis()
	h.Messages.Insert(corestore.Record{
		"queue_name":     stringField(queue, "queue_name"),
		"message_id":     messageID,
		"receipt_handle": h.generateReceiptHandle(),
		"body":           messageBody,
		"md5_of_body":    bodyMD5,
		"attributes": corestore.Record{
			"SentTimestamp":                    strconv.FormatInt(now, 10),
			"ApproximateReceiveCount":          "0",
			"ApproximateFirstReceiveTimestamp": "",
			"SenderId":                         h.accountID(),
		},
		"message_attributes": parseMessageAttributes(params),
		"visible_after":      now + int64(intField(queue, "delay_seconds"))*1000,
		"sent_timestamp":     now,
		"receive_count":      0,
	})
	body := `<?xml version="1.0" encoding="UTF-8"?>
<SendMessageResponse>
  <SendMessageResult>
    <MessageId>` + xmlEscape(messageID) + `</MessageId>
    <MD5OfMessageBody>` + bodyMD5 + `</MD5OfMessageBody>
  </SendMessageResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</SendMessageResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) receiveMessage(params map[string]string, requestID string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFound(requestID)
	}
	maxMessages := intParam(params["MaxNumberOfMessages"], 1)
	if maxMessages > 10 {
		maxMessages = 10
	}
	if maxMessages < 1 {
		maxMessages = 1
	}
	visibilityTimeout := intParam(params["VisibilityTimeout"], intField(queue, "visibility_timeout"))
	now := h.nowMillis()
	allMessages := h.Messages.FindBy("queue_name", stringField(queue, "queue_name"))
	batch := make([]corestore.Record, 0, maxMessages)
	for _, message := range allMessages {
		if int64Field(message, "visible_after") > now {
			continue
		}
		receiptHandle := h.generateReceiptHandle()
		receiveCount := intField(message, "receive_count") + 1
		updated, _ := h.Messages.Update(intField(message, "id"), corestore.Record{
			"receipt_handle": receiptHandle,
			"visible_after":  now + int64(visibilityTimeout)*1000,
			"receive_count":  receiveCount,
		})
		batch = append(batch, updated)
		if len(batch) == maxMessages {
			break
		}
	}
	var rows strings.Builder
	for _, message := range batch {
		rows.WriteString(`    <Message>
      <MessageId>`)
		rows.WriteString(xmlEscape(stringField(message, "message_id")))
		rows.WriteString(`</MessageId>
      <ReceiptHandle>`)
		rows.WriteString(xmlEscape(stringField(message, "receipt_handle")))
		rows.WriteString(`</ReceiptHandle>
      <MD5OfBody>`)
		rows.WriteString(xmlEscape(stringField(message, "md5_of_body")))
		rows.WriteString(`</MD5OfBody>
      <Body>`)
		rows.WriteString(xmlEscape(stringField(message, "body")))
		rows.WriteString(`</Body>
      <Attribute><Name>SentTimestamp</Name><Value>`)
		rows.WriteString(strconv.FormatInt(int64Field(message, "sent_timestamp"), 10))
		rows.WriteString(`</Value></Attribute>
      <Attribute><Name>ApproximateReceiveCount</Name><Value>`)
		rows.WriteString(strconv.Itoa(intField(message, "receive_count")))
		rows.WriteString(`</Value></Attribute>
      <Attribute><Name>ApproximateFirstReceiveTimestamp</Name><Value>`)
		rows.WriteString(strconv.FormatInt(int64Field(message, "sent_timestamp"), 10))
		rows.WriteString(`</Value></Attribute>
    </Message>
`)
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<ReceiveMessageResponse>
  <ReceiveMessageResult>
` + strings.TrimRight(rows.String(), "\n") + `
  </ReceiveMessageResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</ReceiveMessageResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) deleteMessage(params map[string]string, requestID string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFound(requestID)
	}
	for _, message := range h.Messages.FindBy("queue_name", stringField(queue, "queue_name")) {
		if stringField(message, "receipt_handle") == params["ReceiptHandle"] {
			h.Messages.Delete(intField(message, "id"))
			break
		}
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<DeleteMessageResponse>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</DeleteMessageResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) purgeQueue(params map[string]string, requestID string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFound(requestID)
	}
	for _, message := range h.Messages.FindBy("queue_name", stringField(queue, "queue_name")) {
		h.Messages.Delete(intField(message, "id"))
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<PurgeQueueResponse>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</PurgeQueueResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) createQueueJSON(req *http.Request, params map[string]string) protocols.ErrorResponse {
	queueName := params["QueueName"]
	if queueName == "" {
		return jsonResponse(http.StatusBadRequest, map[string]any{"__type": "MissingParameter", "message": "The request must contain the parameter QueueName."})
	}
	if existing, ok := h.findQueueByName(queueName); ok {
		return jsonResponse(http.StatusOK, map[string]any{"QueueUrl": stringField(existing, "queue_url")})
	}
	attrs := indexedAttributes(params, "Attribute")
	region := h.region()
	accountID := h.accountID()
	queueURL := strings.TrimRight(h.baseURL(req), "/") + "/sqs/" + accountID + "/" + queueName
	h.Queues.Insert(corestore.Record{
		"queue_name":                queueName,
		"queue_url":                 queueURL,
		"arn":                       "arn:aws:sqs:" + region + ":" + accountID + ":" + queueName,
		"visibility_timeout":        intParam(attrs["VisibilityTimeout"], 30),
		"delay_seconds":             intParam(attrs["DelaySeconds"], 0),
		"max_message_size":          intParam(attrs["MaximumMessageSize"], 262144),
		"message_retention_period":  intParam(attrs["MessageRetentionPeriod"], 345600),
		"receive_message_wait_time": intParam(attrs["ReceiveMessageWaitTimeSeconds"], 0),
		"fifo":                      strings.HasSuffix(queueName, ".fifo"),
	})
	return jsonResponse(http.StatusOK, map[string]any{"QueueUrl": queueURL})
}

func (h *Handler) deleteQueueJSON(params map[string]string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFoundJSON()
	}
	for _, message := range h.Messages.FindBy("queue_name", stringField(queue, "queue_name")) {
		h.Messages.Delete(intField(message, "id"))
	}
	h.Queues.Delete(intField(queue, "id"))
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) listQueuesJSON(params map[string]string) protocols.ErrorResponse {
	prefix := params["QueueNamePrefix"]
	queueURLs := []string{}
	for _, queue := range h.Queues.All() {
		if prefix != "" && !strings.HasPrefix(stringField(queue, "queue_name"), prefix) {
			continue
		}
		queueURLs = append(queueURLs, stringField(queue, "queue_url"))
	}
	return jsonResponse(http.StatusOK, map[string]any{"QueueUrls": queueURLs})
}

func (h *Handler) getQueueURLJSON(params map[string]string) protocols.ErrorResponse {
	queue, ok := h.findQueueByName(params["QueueName"])
	if !ok {
		return h.queueNotFoundJSON()
	}
	return jsonResponse(http.StatusOK, map[string]any{"QueueUrl": stringField(queue, "queue_url")})
}

func (h *Handler) getQueueAttributesJSON(params map[string]string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFoundJSON()
	}
	now := h.nowMillis()
	visibleCount := 0
	inFlightCount := 0
	for _, message := range h.Messages.FindBy("queue_name", stringField(queue, "queue_name")) {
		if int64Field(message, "visible_after") <= now {
			visibleCount++
		} else {
			inFlightCount++
		}
	}
	return jsonResponse(http.StatusOK, map[string]any{"Attributes": map[string]string{
		"QueueArn":                              stringField(queue, "arn"),
		"ApproximateNumberOfMessages":           strconv.Itoa(visibleCount),
		"ApproximateNumberOfMessagesNotVisible": strconv.Itoa(inFlightCount),
		"VisibilityTimeout":                     strconv.Itoa(intField(queue, "visibility_timeout")),
		"MaximumMessageSize":                    strconv.Itoa(intField(queue, "max_message_size")),
		"MessageRetentionPeriod":                strconv.Itoa(intField(queue, "message_retention_period")),
		"DelaySeconds":                          strconv.Itoa(intField(queue, "delay_seconds")),
		"ReceiveMessageWaitTimeSeconds":         strconv.Itoa(intField(queue, "receive_message_wait_time")),
		"FifoQueue":                             strconv.FormatBool(boolField(queue, "fifo")),
	}})
}

func (h *Handler) sendMessageJSON(params map[string]string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFoundJSON()
	}
	messageBody := params["MessageBody"]
	if messageBody == "" {
		return jsonResponse(http.StatusBadRequest, map[string]any{"__type": "MissingParameter", "message": "The request must contain the parameter MessageBody."})
	}
	if len([]byte(messageBody)) > intField(queue, "max_message_size") {
		return jsonResponse(http.StatusBadRequest, map[string]any{"__type": "InvalidParameterValue", "message": "One or more parameters are invalid. Reason: Message must be shorter than " + strconv.Itoa(intField(queue, "max_message_size")) + " bytes."})
	}
	messageID := h.generateID()
	bodyMD5 := md5Hex(messageBody)
	now := h.nowMillis()
	h.Messages.Insert(corestore.Record{
		"queue_name":     stringField(queue, "queue_name"),
		"message_id":     messageID,
		"receipt_handle": h.generateReceiptHandle(),
		"body":           messageBody,
		"md5_of_body":    bodyMD5,
		"attributes": corestore.Record{
			"SentTimestamp":                    strconv.FormatInt(now, 10),
			"ApproximateReceiveCount":          "0",
			"ApproximateFirstReceiveTimestamp": "",
			"SenderId":                         h.accountID(),
		},
		"message_attributes": parseMessageAttributes(params),
		"visible_after":      now + int64(intField(queue, "delay_seconds"))*1000,
		"sent_timestamp":     now,
		"receive_count":      0,
	})
	return jsonResponse(http.StatusOK, map[string]any{
		"MD5OfMessageBody": bodyMD5,
		"MessageId":        messageID,
	})
}

func (h *Handler) receiveMessageJSON(params map[string]string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFoundJSON()
	}
	maxMessages := intParam(params["MaxNumberOfMessages"], 1)
	if maxMessages > 10 {
		maxMessages = 10
	}
	if maxMessages < 1 {
		maxMessages = 1
	}
	visibilityTimeout := intParam(params["VisibilityTimeout"], intField(queue, "visibility_timeout"))
	now := h.nowMillis()
	messages := make([]map[string]any, 0, maxMessages)
	for _, message := range h.Messages.FindBy("queue_name", stringField(queue, "queue_name")) {
		if int64Field(message, "visible_after") > now {
			continue
		}
		receiptHandle := h.generateReceiptHandle()
		receiveCount := intField(message, "receive_count") + 1
		updated, _ := h.Messages.Update(intField(message, "id"), corestore.Record{
			"receipt_handle": receiptHandle,
			"visible_after":  now + int64(visibilityTimeout)*1000,
			"receive_count":  receiveCount,
		})
		messages = append(messages, map[string]any{
			"MessageId":     stringField(updated, "message_id"),
			"ReceiptHandle": stringField(updated, "receipt_handle"),
			"MD5OfBody":     stringField(updated, "md5_of_body"),
			"Body":          stringField(updated, "body"),
			"Attributes": map[string]string{
				"SentTimestamp":                    strconv.FormatInt(int64Field(updated, "sent_timestamp"), 10),
				"ApproximateReceiveCount":          strconv.Itoa(intField(updated, "receive_count")),
				"ApproximateFirstReceiveTimestamp": strconv.FormatInt(int64Field(updated, "sent_timestamp"), 10),
			},
		})
		if len(messages) == maxMessages {
			break
		}
	}
	return jsonResponse(http.StatusOK, map[string]any{"Messages": messages})
}

func (h *Handler) deleteMessageJSON(params map[string]string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFoundJSON()
	}
	for _, message := range h.Messages.FindBy("queue_name", stringField(queue, "queue_name")) {
		if stringField(message, "receipt_handle") == params["ReceiptHandle"] {
			h.Messages.Delete(intField(message, "id"))
			break
		}
	}
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) purgeQueueJSON(params map[string]string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFoundJSON()
	}
	for _, message := range h.Messages.FindBy("queue_name", stringField(queue, "queue_name")) {
		h.Messages.Delete(intField(message, "id"))
	}
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) queueURLResponse(action string, queueURL string, requestID string) protocols.ErrorResponse {
	body := `<?xml version="1.0" encoding="UTF-8"?>
<` + action + `Response>
  <` + action + `Result>
    <QueueUrl>` + xmlEscape(queueURL) + `</QueueUrl>
  </` + action + `Result>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</` + action + `Response>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) queueNotFound(requestID string) protocols.ErrorResponse {
	return h.queryError("AWS.SimpleQueueService.NonExistentQueue", "The specified queue does not exist.", http.StatusBadRequest, requestID)
}

func (h *Handler) queueNotFoundJSON() protocols.ErrorResponse {
	return jsonResponse(http.StatusBadRequest, map[string]any{"__type": "QueueDoesNotExist", "message": "The specified queue does not exist."})
}

func (h *Handler) queryError(code string, message string, status int, requestID string) protocols.ErrorResponse {
	return protocols.SerializeXMLError(protocols.AWSError{
		Code:       code,
		Message:    message,
		RequestID:  requestID,
		StatusCode: status,
	})
}

func (h *Handler) findQueueByName(queueName string) (corestore.Record, bool) {
	for _, queue := range h.Queues.FindBy("queue_name", queueName) {
		return queue, true
	}
	return nil, false
}

func (h *Handler) findQueueByURL(queueURL string) (corestore.Record, bool) {
	for _, queue := range h.Queues.FindBy("queue_url", queueURL) {
		return queue, true
	}
	return nil, false
}

func (h *Handler) now() time.Time {
	if h.Now != nil {
		return h.Now().UTC()
	}
	return time.Now().UTC()
}

func (h *Handler) nowMillis() int64 {
	return h.now().UnixNano() / int64(time.Millisecond)
}

func (h *Handler) region() string {
	if h.Region != "" {
		return h.Region
	}
	return gateway.DefaultRegion
}

func (h *Handler) accountID() string {
	if h.AccountID != "" {
		return h.AccountID
	}
	return gateway.DefaultAccountID
}

func (h *Handler) baseURL(req *http.Request) string {
	if h.BaseURL != "" {
		return h.BaseURL
	}
	scheme := "http"
	if req.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + req.Host
}

func (h *Handler) generateID() string {
	if h.IDGenerator != nil {
		return h.IDGenerator()
	}
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err == nil {
		return hex.EncodeToString(bytes[0:4]) + "-" + hex.EncodeToString(bytes[4:6]) + "-" + hex.EncodeToString(bytes[6:8]) + "-" + hex.EncodeToString(bytes[8:10]) + "-" + hex.EncodeToString(bytes[10:16])
	}
	return fmt.Sprintf("msg-%d", fallbackIDCounter.Add(1))
}

func (h *Handler) generateReceiptHandle() string {
	if h.ReceiptGenerator != nil {
		return h.ReceiptGenerator()
	}
	var bytes [48]byte
	if _, err := rand.Read(bytes[:]); err == nil {
		return base64.RawURLEncoding.EncodeToString(bytes[:])
	}
	return fmt.Sprintf("receipt-%d", fallbackIDCounter.Add(1))
}

func xmlResponse(status int, body string) protocols.ErrorResponse {
	return protocols.ErrorResponse{
		StatusCode:  status,
		ContentType: "application/xml",
		Headers:     map[string]string{"Content-Type": "application/xml"},
		Body:        []byte(body),
	}
}

func jsonResponse(status int, value any) protocols.ErrorResponse {
	body, _ := json.Marshal(value)
	return protocols.ErrorResponse{
		StatusCode:  status,
		ContentType: "application/x-amz-json-1.0",
		Headers:     map[string]string{"Content-Type": "application/x-amz-json-1.0"},
		Body:        body,
	}
}

func withRequestID(response protocols.ErrorResponse, requestID string) protocols.ErrorResponse {
	if requestID == "" {
		return response
	}
	if response.Headers == nil {
		response.Headers = map[string]string{}
	}
	if response.Headers["x-amzn-requestid"] == "" {
		response.Headers["x-amzn-requestid"] = requestID
	}
	return response
}

func jsonParams(input map[string]any) map[string]string {
	params := map[string]string{}
	attributeIndex := 1
	messageAttributeIndex := 1
	for key, value := range input {
		switch key {
		case "Attributes":
			if values, ok := value.(map[string]any); ok {
				for name, attrValue := range values {
					index := strconv.Itoa(attributeIndex)
					params["Attribute."+index+".Name"] = name
					params["Attribute."+index+".Value"] = scalarString(attrValue)
					attributeIndex++
				}
			}
		case "MessageAttributes":
			if values, ok := value.(map[string]any); ok {
				for name, rawAttr := range values {
					attr, ok := rawAttr.(map[string]any)
					if !ok {
						continue
					}
					index := strconv.Itoa(messageAttributeIndex)
					prefix := "MessageAttribute." + index
					params[prefix+".Name"] = name
					params[prefix+".Value.DataType"] = scalarString(attr["DataType"])
					params[prefix+".Value.StringValue"] = scalarString(attr["StringValue"])
					params[prefix+".Value.BinaryValue"] = scalarString(attr["BinaryValue"])
					messageAttributeIndex++
				}
			}
		default:
			params[key] = scalarString(value)
		}
	}
	return params
}

func scalarString(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	case json.Number:
		return v.String()
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(v)
	default:
		return fmt.Sprint(v)
	}
}

func indexedAttributes(params map[string]string, prefix string) map[string]string {
	attrs := map[string]string{}
	for index := 1; ; index++ {
		name := params[prefix+"."+strconv.Itoa(index)+".Name"]
		if name == "" {
			break
		}
		attrs[name] = params[prefix+"."+strconv.Itoa(index)+".Value"]
	}
	return attrs
}

func parseMessageAttributes(params map[string]string) corestore.Record {
	attrs := corestore.Record{}
	for index := 1; ; index++ {
		prefix := "MessageAttribute." + strconv.Itoa(index)
		name := params[prefix+".Name"]
		if name == "" {
			break
		}
		value := corestore.Record{
			"DataType": params[prefix+".Value.DataType"],
		}
		if stringValue := params[prefix+".Value.StringValue"]; stringValue != "" {
			value["StringValue"] = stringValue
		}
		if binaryValue := params[prefix+".Value.BinaryValue"]; binaryValue != "" {
			value["BinaryValue"] = binaryValue
		}
		attrs[name] = value
	}
	return attrs
}

func intParam(raw string, fallback int) int {
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return value
}

func stringField(record corestore.Record, name string) string {
	switch value := record[name].(type) {
	case string:
		return value
	default:
		if value == nil {
			return ""
		}
		return fmt.Sprint(value)
	}
}

func intField(record corestore.Record, name string) int {
	switch value := record[name].(type) {
	case int:
		return value
	case int64:
		return int(value)
	case float64:
		return int(value)
	default:
		return 0
	}
}

func int64Field(record corestore.Record, name string) int64 {
	switch value := record[name].(type) {
	case int64:
		return value
	case int:
		return int64(value)
	case float64:
		return int64(value)
	default:
		return 0
	}
}

func boolField(record corestore.Record, name string) bool {
	value, _ := record[name].(bool)
	return value
}

func md5Hex(value string) string {
	sum := md5.Sum([]byte(value))
	return hex.EncodeToString(sum[:])
}

type nameValue struct {
	Name  string
	Value string
}

func xmlEscape(value string) string {
	replacer := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&apos;",
	)
	return replacer.Replace(value)
}
