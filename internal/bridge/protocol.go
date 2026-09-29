// Package bridge connects CLI processes to the Chrome extension. Chrome
// spawns `xwebmcp` as a native messaging host; that process relays requests
// from a local Unix socket to the extension and responses back.
package bridge

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// Chrome refuses native messages above 1 MiB from the host.
const maxHostMessageBytes = 1 << 20

// Request is one call to the extension API.
type Request struct {
	ID     int64           `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

// Response answers a Request.
type Response struct {
	ID     int64           `json:"id"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *Error          `json:"error,omitempty"`
}

// Error is an extension-side failure.
type Error struct {
	Message      string `json:"message"`
	Code         string `json:"code,omitempty"`
	InvocationID string `json:"invocation_id,omitempty"`
}

func (e *Error) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("%s (%s)", e.Message, e.Code)
	}
	return e.Message
}

// ReadNativeMessage reads one length-prefixed native messaging frame.
func ReadNativeMessage(r io.Reader) ([]byte, error) {
	var length uint32
	if err := binary.Read(r, binary.LittleEndian, &length); err != nil {
		return nil, err
	}
	if length > 64<<20 {
		return nil, fmt.Errorf("native message of %d bytes is too large", length)
	}
	buf := make([]byte, length)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

// WriteNativeMessage writes one length-prefixed native messaging frame.
func WriteNativeMessage(w io.Writer, payload []byte) error {
	if len(payload) > maxHostMessageBytes {
		return errors.New("native message exceeds Chrome's 1 MiB limit")
	}
	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], uint32(len(payload)))
	if _, err := w.Write(header[:]); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}
