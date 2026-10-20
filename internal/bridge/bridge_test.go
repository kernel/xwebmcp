package bridge

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// fakeChrome answers native messages the way the extension would.
func fakeChrome(t *testing.T, fromHost io.Reader, toHost io.Writer, handler func(Request) Response) {
	t.Helper()
	go func() {
		for {
			payload, err := ReadNativeMessage(fromHost)
			if err != nil {
				return
			}
			var request Request
			if err := json.Unmarshal(payload, &request); err != nil {
				t.Errorf("chrome received invalid request: %v", err)
				return
			}
			response := handler(request)
			response.ID = request.ID
			data, _ := json.Marshal(response)
			if err := WriteNativeMessage(toHost, data); err != nil {
				return
			}
		}
	}()
}

func TestNativeFraming(t *testing.T) {
	r, w := io.Pipe()
	go func() {
		WriteNativeMessage(w, []byte(`{"id":1}`))
		w.Close()
	}()
	got, err := ReadNativeMessage(r)
	if err != nil || string(got) != `{"id":1}` {
		t.Fatalf("round trip = %q, %v", got, err)
	}
	if _, err := ReadNativeMessage(r); err != io.EOF {
		t.Errorf("expected EOF, got %v", err)
	}
	if err := WriteNativeMessage(io.Discard, make([]byte, maxHostMessageBytes+1)); err == nil {
		t.Error("oversized message should be rejected")
	}
}

func TestHostRelaysRequests(t *testing.T) {
	stateDir := filepath.Join(shortTempDir(t), "s")
	chromeToHost, hostStdin := io.Pipe()
	chromeFromHost, hostStdout := io.Pipe()
	fakeChrome(t, chromeFromHost, hostStdin, func(request Request) Response {
		switch request.Method {
		case "ping":
			return Response{Result: json.RawMessage(`{"version":"0.1.0"}`)}
		case "echo":
			return Response{Result: request.Params}
		default:
			return Response{Error: &Error{Message: "unknown method " + request.Method, Code: "bad_method"}}
		}
	})

	host := NewHost(stateDir, chromeToHost, hostStdout, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- host.Run(ctx) }()

	socket := SocketPath(stateDir)
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(socket); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("socket never appeared")
		}
		time.Sleep(10 * time.Millisecond)
	}

	client, err := Dial(ctx, stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	info, err := client.Ping(ctx)
	if err != nil || info["version"] != "0.1.0" {
		t.Fatalf("ping = %v, %v", info, err)
	}
	var echoed map[string]any
	if err := client.Call(ctx, "echo", map[string]any{"a": 1}, &echoed); err != nil || echoed["a"] != float64(1) {
		t.Fatalf("echo = %v, %v", echoed, err)
	}
	err = client.Call(ctx, "nope", nil, nil)
	var bridgeErr *Error
	if !asBridgeError(err, &bridgeErr) || bridgeErr.Code != "bad_method" {
		t.Fatalf("error = %v", err)
	}

	// Chrome closing stdin ends the host and clears the socket.
	hostStdin.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("host exited with %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("host did not exit after Chrome closed stdin")
	}
	if _, err := os.Stat(socket); !os.IsNotExist(err) {
		t.Errorf("socket not removed: %v", err)
	}
	if _, err := Dial(ctx, stateDir); err != ErrNotRunning {
		t.Errorf("Dial after shutdown = %v, want ErrNotRunning", err)
	}
}

func asBridgeError(err error, target **Error) bool {
	if e, ok := err.(*Error); ok {
		*target = e
		return true
	}
	return false
}

// Unix socket paths are limited to ~104 bytes; t.TempDir can exceed that.
func shortTempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "xwb")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

// startHost runs a host with a fake Chrome that answers ping with version.
func startHost(t *testing.T, stateDir, version string) (stop func()) {
	t.Helper()
	chromeToHost, hostStdin := io.Pipe()
	chromeFromHost, hostStdout := io.Pipe()
	fakeChrome(t, chromeFromHost, hostStdin, func(request Request) Response {
		return Response{Result: json.RawMessage(`{"version":"` + version + `"}`)}
	})
	host := NewHost(stateDir, chromeToHost, hostStdout, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- host.Run(ctx) }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(SocketPath(stateDir)); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("socket never appeared")
		}
		time.Sleep(10 * time.Millisecond)
	}
	return func() {
		hostStdin.Close()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("host did not stop")
		}
		cancel()
	}
}

func TestClientReconnectsAfterHostRestart(t *testing.T) {
	stateDir := filepath.Join(shortTempDir(t), "s")
	stop := startHost(t, stateDir, "first")
	ctx := context.Background()
	client, err := Dial(ctx, stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if info, err := client.Ping(ctx); err != nil || info["version"] != "first" {
		t.Fatalf("ping = %v, %v", info, err)
	}

	// The extension reloads: Chrome closes the old host and starts a new one.
	// A request already written to the old host when it stops is reported as
	// possibly-run (never resent); wait until the client has seen the close,
	// then the next call must reach the new host.
	stop()
	waitDisconnected(t, client)
	restarted := make(chan func(), 1)
	go func() {
		time.Sleep(300 * time.Millisecond)
		restarted <- startHost(t, stateDir, "second")
	}()
	info, err := client.Ping(ctx)
	if err != nil || info["version"] != "second" {
		t.Fatalf("ping after restart = %v, %v", info, err)
	}
	(<-restarted)()
}

func TestClientReportsNotRunningWhenNoHostReturns(t *testing.T) {
	stateDir := filepath.Join(shortTempDir(t), "s")
	stop := startHost(t, stateDir, "only")
	ctx := context.Background()
	client, err := Dial(ctx, stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	stop()
	short, cancel := context.WithTimeout(ctx, 600*time.Millisecond)
	defer cancel()
	if _, err := client.Ping(short); err == nil {
		t.Fatal("ping with no host should fail")
	}
}

func waitDisconnected(t *testing.T, client *Client) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		client.mu.Lock()
		current := client.current
		client.mu.Unlock()
		if current == nil || !current.alive() {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("client never noticed the host stopped")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
