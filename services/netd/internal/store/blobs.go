package store

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	DefaultBlobRead = 8 * 1024
	MaxBlobRead     = 64 * 1024
)

var sha256Re = regexp.MustCompile(`^[0-9a-f]{64}$`)

type TrafficBlobRef struct {
	SHA256      string `json:"sha256"`
	Size        int64  `json:"size"`
	ContentType string `json:"contentType,omitempty"`
}

func blobRoot(taskDir string) string {
	abs, err := filepath.Abs(filepath.Join(taskDir, "traffic", "_blobs", "sha256"))
	if err != nil {
		return filepath.Join(taskDir, "traffic", "_blobs", "sha256")
	}
	return abs
}

func BlobPath(taskDir, hash string) (string, error) {
	h := strings.ToLower(strings.TrimSpace(hash))
	if !sha256Re.MatchString(h) {
		return "", errors.New("invalid sha256")
	}
	root := blobRoot(taskDir)
	dest := filepath.Join(root, h[:2], h+".bin")
	rel, err := filepath.Rel(root, dest)
	if err != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return "", errors.New("blob path escaped the task store")
	}
	return dest, nil
}

func PutBlob(taskDir string, data []byte, contentType string) (*TrafficBlobRef, error) {
	if len(data) == 0 {
		return nil, nil
	}
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])
	dest, err := BlobPath(taskDir, hash)
	if err != nil {
		return nil, err
	}
	if _, statErr := os.Stat(dest); statErr != nil {
		if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
			return nil, err
		}
		tmp := fmt.Sprintf("%s.%d.%d.tmp", dest, os.Getpid(), time.Now().UnixNano())
		if err := os.WriteFile(tmp, data, 0o600); err != nil {
			return nil, err
		}
		_ = os.Chmod(tmp, 0o600)
		if _, existsErr := os.Stat(dest); existsErr == nil {
			_ = os.Remove(tmp)
		} else if err := os.Rename(tmp, dest); err != nil {
			if _, existsErr := os.Stat(dest); existsErr == nil {
				_ = os.Remove(tmp)
			} else {
				_ = os.Remove(tmp)
				return nil, err
			}
		}
	}
	return &TrafficBlobRef{
		SHA256:      hash,
		Size:        int64(len(data)),
		ContentType: contentType,
	}, nil
}

func CommitHashedFile(taskDir, tmpPath, hash string, size int64, contentType string) (*TrafficBlobRef, error) {
	if size <= 0 {
		_ = os.Remove(tmpPath)
		return nil, nil
	}
	dest, err := BlobPath(taskDir, hash)
	if err != nil {
		_ = os.Remove(tmpPath)
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
		_ = os.Remove(tmpPath)
		return nil, err
	}
	if _, existsErr := os.Stat(dest); existsErr == nil {
		_ = os.Remove(tmpPath)
	} else {
		_ = os.Chmod(tmpPath, 0o600)
		if err := os.Rename(tmpPath, dest); err != nil {
			if _, existsErr := os.Stat(dest); existsErr == nil {
				_ = os.Remove(tmpPath)
			} else {
				_ = os.Remove(tmpPath)
				return nil, err
			}
		}
	}
	return &TrafficBlobRef{
		SHA256:      strings.ToLower(strings.TrimSpace(hash)),
		Size:        size,
		ContentType: contentType,
	}, nil
}

func ReadBlobSlice(taskDir, hash string, offset, maxBytes int) ([]byte, int64, *int, error) {
	if offset < 0 {
		return nil, 0, nil, errors.New("invalid offset")
	}
	if maxBytes < 1 {
		return nil, 0, nil, errors.New("invalid maxBytes")
	}
	if maxBytes > MaxBlobRead {
		return nil, 0, nil, fmt.Errorf("maxBytes exceeds %d", MaxBlobRead)
	}
	path, err := BlobPath(taskDir, hash)
	if err != nil {
		return nil, 0, nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, 0, nil, err
	}
	size := info.Size()
	if int64(offset) >= size {
		return []byte{}, size, nil, nil
	}
	length := int64(maxBytes)
	if rem := size - int64(offset); rem < length {
		length = rem
	}
	buf := make([]byte, length)
	n, err := f.ReadAt(buf, int64(offset))
	if err != nil && int64(n) < length {
		return nil, 0, nil, err
	}
	buf = buf[:n]
	next := offset + n
	var nextPtr *int
	if int64(next) < size {
		nextPtr = &next
	}
	return buf, size, nextPtr, nil
}

func ReadBlobBytes(taskDir, hash string, maxBytes int64) ([]byte, error) {
	if maxBytes < 1 {
		return nil, nil
	}
	path, err := BlobPath(taskDir, hash)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.Size() <= 0 || info.Size() > maxBytes {
		return nil, nil
	}
	return os.ReadFile(path)
}
