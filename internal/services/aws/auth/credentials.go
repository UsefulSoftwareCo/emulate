package auth

import "sync"

type Credential struct {
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
	AccountID       string
	PrincipalARN    string
	Disabled        bool
}

type Store struct {
	mu          sync.RWMutex
	credentials map[string]Credential
}

func NewStore(credentials ...Credential) *Store {
	store := &Store{credentials: map[string]Credential{}}
	for _, credential := range credentials {
		if credential.AccessKeyID == "" {
			continue
		}
		store.credentials[credential.AccessKeyID] = credential
	}
	return store
}

func (store *Store) Resolve(accessKeyID string) (Credential, bool) {
	if store == nil || accessKeyID == "" {
		return Credential{}, false
	}
	store.mu.RLock()
	defer store.mu.RUnlock()
	credential, ok := store.credentials[accessKeyID]
	if !ok || credential.Disabled {
		return Credential{}, false
	}
	return credential, true
}

func (store *Store) Put(credential Credential) bool {
	if store == nil || credential.AccessKeyID == "" {
		return false
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	store.credentials[credential.AccessKeyID] = credential
	return true
}

func (store *Store) Delete(accessKeyID string) bool {
	if store == nil || accessKeyID == "" {
		return false
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if _, ok := store.credentials[accessKeyID]; !ok {
		return false
	}
	delete(store.credentials, accessKeyID)
	return true
}
