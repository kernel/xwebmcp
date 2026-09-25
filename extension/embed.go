// Package extension embeds the unpacked Chrome extension so the CLI can write
// it to disk and derive its stable extension ID from the manifest key.
package extension

import (
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

//go:embed manifest.json background.js offscreen.html offscreen.js popup.html popup.js sidepanel.html sidepanel.js background/*.js content/*.js lib/*.js sandbox/*.js sandbox/*.html
var files embed.FS

// FS returns the extension files.
func FS() fs.FS { return files }

// Manifest reads the embedded manifest.
func Manifest() (map[string]any, error) {
	data, err := files.ReadFile("manifest.json")
	if err != nil {
		return nil, err
	}
	var manifest map[string]any
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, fmt.Errorf("parse manifest.json: %w", err)
	}
	return manifest, nil
}

// ID derives the extension ID Chrome assigns from the manifest's public key:
// the first 128 bits of the SHA-256 of the DER key, written in the a-p
// alphabet.
func ID() (string, error) {
	manifest, err := Manifest()
	if err != nil {
		return "", err
	}
	key, _ := manifest["key"].(string)
	return IDFromKey(key)
}

// IDFromKey computes the extension ID for a base64 DER public key.
func IDFromKey(key string) (string, error) {
	if key == "" {
		return "", fmt.Errorf("manifest has no key")
	}
	der, err := base64.StdEncoding.DecodeString(key)
	if err != nil {
		return "", fmt.Errorf("decode manifest key: %w", err)
	}
	sum := sha256.Sum256(der)
	id := make([]byte, 32)
	for i, b := range sum[:16] {
		id[2*i] = 'a' + b>>4
		id[2*i+1] = 'a' + b&0x0f
	}
	return string(id), nil
}

// Version returns the manifest version.
func Version() (string, error) {
	manifest, err := Manifest()
	if err != nil {
		return "", err
	}
	version, _ := manifest["version"].(string)
	return version, nil
}

// Write copies the extension into dir, replacing existing files and leaving
// anything else in the directory untouched.
func Write(dir string) error {
	return fs.WalkDir(files, ".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		target := filepath.Join(dir, filepath.FromSlash(path))
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := files.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
}
