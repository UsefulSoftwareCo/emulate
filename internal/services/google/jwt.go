package google

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"time"
)

const googleKeyID = "emulate-google-1"

const googlePrivateKeyPEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDN6/Ue1NvyScGV
+HMwpLs3Xs0IC1kvT+IFezVCfA3gez5r9TE9cNZqm0+DvqFbVpB1gqhYmOGM0aeF
MzddI7JEn1vltFNDJh25OewX87PtkZDTqukn6GEgdQ8qV59GUNnmDIKbxt+UHM1i
IaeESomoor+PJISF1LpIjn0QOoQGKnKgljN5p3OA84NHkPSXWD+ZqKcVXKBCV65/
5SXgP7IAsfFSxktXUw86x7TYam9N8ulZ+rM7MtXrrin1SA8gPyn900kyPVbYvKXY
e9a2Z9h2G6PMNZgSszW9jVJnh1twZyvQLqFYysc5NcfNb/17e9nG+rJ8bmxqpcTf
wQQgCiORAgMBAAECggEAIgkhZYRwy0ICH4fmgDCGKj9+25jGl7GYLehAtBm9kHBG
b8Eh76IWKp47nQ617FspOucK7MPuKeCgU/2UZc5n4XxGi/fLeFKVQJ+QhJ/5CigQ
fE/oRDqeTSdUB59eediUv3erYdST8U72aoUeA1lvmeI2j9INHnK8DJCSnstRNZRj
xmqQAvcEAz6ZE4LE1bc91Ckm3VWB0MbgoQo/drezYcOP7/OFZVXzuzcQM8mwCuP3
BKXmrVOKpThbFt7wwPQSLUZJgLfCCIlEy0mP3STPPZbLS/gXz/sLn7tpks59gjGu
miPuygQY7yc2NyTh/Xfxb5rJ7Vfv+YWY0AIqtTEQnQKBgQD9AsYyg5rCFzhniCfo
mYiCvJYY+jY4FU3z4UlQ2ML68nfFc6UG/DfvQ1AMel1B8Ls0CW2gpgTBCRydC6vt
5XL6yRBEe6AvuJLKtwudHgb5RfHZlV6zgO65EgAz8JEb52bfwsBdzlmhRGcMzwEM
Pomgh/D8aglmGhlnXMj2evTEXQKBgQDQWsNkKp1sQBq7drfulhb6kOpInPhIiUkO
Yhxd47hvAsQ4NTDkYpblWkC69tqlzXmNZUd7qX5RFZGes/M9E/Lo/WPk98/AWBcP
UTFJT/NYyHLLm7bSatvjIYPiDyPaSVW8VO6TX+28xuoZyKvsqaR3isPWz/uZ/8G6
FgPJtvqoxQKBgBNiTAcAuDGYj9S2xL/4S1Ig2qsNOGwxjahaoUBVaxLI0s5I3uLb
HfnxwUdDdLOhmuYQttpw/bpAVXXeuAxg4N8/2kQ06H/fdzeasIQYEda1OiM+Y2QD
Q8bgDy3rh2KI5wPLqutE7O8DC5YaoezrOaYX5CmighfVdg7KOAdSQkBtAoGAfWgD
7whPVFaJQIhGUQ55qjsLKMWCE3a+SC/5TvG/kuGhZQtu8Cf/FvDpwR7Pn7g7D0YE
boQoCXnn+hPptbuKG35YX/pgSy86QffmqG+80pVjsvV4ZtH2o5EKpkfiloJJXl/o
cT/uAg/f28ES6hF5cpJNKcBpedmcqvqRMRo3aNkCgYEAytC42/mj9M3CLKVb3NWU
g/+b70Pqq5CJmh6V9gmxFY3SsRjXIIbaM1dDOvX8GUtIPjP/YrJs/P3zrvIaEs/I
uQ3oz8fnCEgKiZ7S9J58ZMFeeL1IWFYLKdY08dhlrKt8CtbDHQjkiXkWOOoBpaqb
9ZpKz6RiNfRnnGJjLgc4Sa8=
-----END PRIVATE KEY-----`

var googleSigner = mustGoogleJWTSigner()

type googleJWTSigner struct {
	privateKey *rsa.PrivateKey
}

func mustGoogleJWTSigner() *googleJWTSigner {
	block, _ := pem.Decode([]byte(googlePrivateKeyPEM))
	if block == nil {
		panic("failed to decode Google private key")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		privateKey, pkcs1Err := x509.ParsePKCS1PrivateKey(block.Bytes)
		if pkcs1Err == nil {
			return &googleJWTSigner{privateKey: privateKey}
		}
		panic(err)
	}
	privateKey, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		panic("Google private key is not RSA")
	}
	return &googleJWTSigner{privateKey: privateKey}
}

func (s *googleJWTSigner) jwks() map[string]any {
	publicKey := s.privateKey.Public().(*rsa.PublicKey)
	return map[string]any{
		"keys": []map[string]any{
			{
				"kty": "RSA",
				"use": "sig",
				"kid": googleKeyID,
				"alg": "RS256",
				"n":   base64.RawURLEncoding.EncodeToString(publicKey.N.Bytes()),
				"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(publicKey.E)).Bytes()),
			},
		},
	}
}

func signIDToken(user map[string]any, clientID string, nonce string, issuer string) (string, error) {
	now := time.Now().Unix()
	claims := map[string]any{
		"iss":            issuer,
		"aud":            clientID,
		"sub":            stringValue(user["uid"]),
		"email":          stringValue(user["email"]),
		"email_verified": user["email_verified"],
		"name":           stringValue(user["name"]),
		"given_name":     stringValue(user["given_name"]),
		"family_name":    stringValue(user["family_name"]),
		"picture":        user["picture"],
		"locale":         stringValue(user["locale"]),
		"iat":            now,
		"exp":            now + 3600,
	}
	if hd := stringValue(user["hd"]); hd != "" {
		claims["hd"] = hd
	}
	if nonce != "" {
		claims["nonce"] = nonce
	}
	return googleSigner.sign(claims)
}

func (s *googleJWTSigner) sign(claims map[string]any) (string, error) {
	header := map[string]any{"alg": "RS256", "kid": googleKeyID, "typ": "JWT"}
	headerJSON, err := json.Marshal(header)
	if err != nil {
		return "", err
	}
	claimsJSON, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	signingInput := base64.RawURLEncoding.EncodeToString(headerJSON) + "." + base64.RawURLEncoding.EncodeToString(claimsJSON)
	digest := sha256.Sum256([]byte(signingInput))
	signature, err := rsa.SignPKCS1v15(rand.Reader, s.privateKey, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}
