package bridge

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
)

// HostName is the native messaging host name registered with Chrome.
const HostName = "sh.kernel.xwebmcp"

// SocketPath returns the Unix socket the host listens on inside the state dir.
func SocketPath(stateDir string) string {
	return filepath.Join(stateDir, "run", "bridge.sock")
}

// Host relays between Chrome (stdin/stdout native messaging) and CLI clients
// (newline-delimited JSON over a Unix socket).
type Host struct {
	stateDir string
	stdin    io.Reader
	stdout   io.Writer
	logf     func(format string, args ...any)

	mu       sync.Mutex
	stdoutMu sync.Mutex
	nextID   atomic.Int64
	pending  map[int64]chan Response
}

// NewHost builds a host for the given state directory.
func NewHost(stateDir string, stdin io.Reader, stdout io.Writer, logf func(string, ...any)) *Host {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &Host{stateDir: stateDir, stdin: stdin, stdout: stdout, logf: logf, pending: map[int64]chan Response{}}
}

// Run serves until Chrome closes stdin or ctx ends.
func (h *Host) Run(ctx context.Context) error {
	socket := SocketPath(h.stateDir)
	if err := os.MkdirAll(filepath.Dir(socket), 0o700); err != nil {
		return err
	}
	_ = os.Remove(socket)
	listener, err := net.Listen("unix", socket)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", socket, err)
	}
	if err := os.Chmod(socket, 0o600); err != nil {
		listener.Close()
		return err
	}
	defer func() {
		listener.Close()
		os.Remove(socket)
	}()

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	go func() {
		h.readChrome()
		cancel()
	}()
	go func() {
		<-ctx.Done()
		listener.Close()
	}()

	for {
		conn, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		go h.serveClient(ctx, conn)
	}
}

func (h *Host) readChrome() {
	reader := bufio.NewReaderSize(h.stdin, 1<<20)
	for {
		payload, err := ReadNativeMessage(reader)
		if err != nil {
			if !errors.Is(err, io.EOF) {
				h.logf("read from chrome: %v", err)
			}
			h.failAll(errors.New("extension disconnected"))
			return
		}
		var response Response
		if err := json.Unmarshal(payload, &response); err != nil || response.ID == 0 {
			continue
		}
		h.mu.Lock()
		ch, ok := h.pending[response.ID]
		delete(h.pending, response.ID)
		h.mu.Unlock()
		if ok {
			ch <- response
		}
	}
}

func (h *Host) failAll(err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, ch := range h.pending {
		ch <- Response{ID: id, Error: &Error{Message: err.Error()}}
		delete(h.pending, id)
	}
}

// Call sends a request to the extension and waits for its reply.
func (h *Host) Call(ctx context.Context, method string, params json.RawMessage) (Response, error) {
	id := h.nextID.Add(1)
	payload, err := json.Marshal(Request{ID: id, Method: method, Params: params})
	if err != nil {
		return Response{}, err
	}
	ch := make(chan Response, 1)
	h.mu.Lock()
	h.pending[id] = ch
	h.mu.Unlock()

	h.stdoutMu.Lock()
	err = WriteNativeMessage(h.stdout, payload)
	h.stdoutMu.Unlock()
	if err != nil {
		h.mu.Lock()
		delete(h.pending, id)
		h.mu.Unlock()
		return Response{}, err
	}
	select {
	case response := <-ch:
		return response, nil
	case <-ctx.Done():
		h.mu.Lock()
		delete(h.pending, id)
		h.mu.Unlock()
		return Response{}, ctx.Err()
	}
}

func (h *Host) serveClient(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	// Close client connections when the host stops, so clients notice and redial the next host.
	go func() {
		<-ctx.Done()
		conn.Close()
	}()
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 0, 64<<10), 16<<20)
	var writeMu sync.Mutex
	for scanner.Scan() {
		line := append([]byte(nil), scanner.Bytes()...)
		var request Request
		if err := json.Unmarshal(line, &request); err != nil {
			continue
		}
		go func() {
			response, err := h.Call(ctx, request.Method, request.Params)
			if err != nil {
				response = Response{Error: &Error{Message: err.Error()}}
			}
			response.ID = request.ID
			data, _ := json.Marshal(response)
			writeMu.Lock()
			defer writeMu.Unlock()
			conn.Write(append(data, '\n'))
		}()
	}
}
