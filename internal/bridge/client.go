package bridge

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

// ErrNotRunning means no native host is listening: Chrome is closed, the
// extension is not loaded, or the host manifest is not installed.
var ErrNotRunning = errors.New("the xwebmcp extension is not connected; open Chrome with the extension loaded, or run `xwebmcp setup chrome`")

// reconnectWait bounds how long a call waits for a restarted native host (for
// example after the extension is reloaded) before reporting ErrNotRunning.
const reconnectWait = 10 * time.Second

// Client talks to a running Host over its Unix socket. The host restarts
// whenever Chrome restarts the extension's native messaging port, so the
// client redials on the next call after its connection is lost.
type Client struct {
	stateDir string
	nextID   atomic.Int64

	mu      sync.Mutex // guards current and closed
	current *connection
	closed  bool
}

// connection is one socket to one host process.
type connection struct {
	conn    net.Conn
	reader  *bufio.Reader
	writeMu sync.Mutex
	mu      sync.Mutex
	pending map[int64]chan Response
	done    chan struct{}
}

// Dial connects to the host socket in stateDir.
func Dial(ctx context.Context, stateDir string) (*Client, error) {
	c := &Client{stateDir: stateDir}
	conn, err := dialOnce(ctx, stateDir)
	if err != nil {
		return nil, err
	}
	c.current = conn
	return c, nil
}

func dialOnce(ctx context.Context, stateDir string) (*connection, error) {
	socket := SocketPath(stateDir)
	if _, err := os.Stat(socket); err != nil {
		return nil, ErrNotRunning
	}
	var dialer net.Dialer
	raw, err := dialer.DialContext(ctx, "unix", socket)
	if err != nil {
		return nil, ErrNotRunning
	}
	conn := &connection{conn: raw, reader: bufio.NewReaderSize(raw, 1<<20), pending: map[int64]chan Response{}, done: make(chan struct{})}
	go conn.readLoop()
	return conn, nil
}

func (c *connection) readLoop() {
	defer close(c.done)
	for {
		line, err := c.reader.ReadBytes('\n')
		if err != nil {
			c.mu.Lock()
			for id, ch := range c.pending {
				ch <- Response{ID: id, Error: &Error{Message: "bridge connection closed before the extension answered; the request may or may not have run"}}
				delete(c.pending, id)
			}
			c.mu.Unlock()
			return
		}
		var response Response
		if json.Unmarshal(line, &response) != nil {
			continue
		}
		c.mu.Lock()
		ch, ok := c.pending[response.ID]
		delete(c.pending, response.ID)
		c.mu.Unlock()
		if ok {
			ch <- response
		}
	}
}

func (c *connection) alive() bool {
	select {
	case <-c.done:
		return false
	default:
		return true
	}
}

// connection returns a live connection, redialing if the previous one closed.
// fresh forces a redial (used after a failed write).
func (c *Client) connection(ctx context.Context, fresh bool) (*connection, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, errors.New("bridge client is closed")
	}
	if c.current != nil && !fresh && c.current.alive() {
		return c.current, nil
	}
	if c.current != nil {
		c.current.conn.Close()
		c.current = nil
	}
	deadline := time.Now().Add(reconnectWait)
	for {
		conn, err := dialOnce(ctx, c.stateDir)
		if err == nil {
			c.current = conn
			return conn, nil
		}
		if time.Now().After(deadline) {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
}

// Close releases the connection.
func (c *Client) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	if c.current == nil {
		return nil
	}
	return c.current.conn.Close()
}

// Call invokes an extension API method and decodes its result into out. If
// the host restarted since the last call, Call reconnects first; a request
// whose write fails is retried once on a new connection, because it never
// reached the host. A request that was sent is never resent.
func (c *Client) Call(ctx context.Context, method string, params any, out any) error {
	var raw json.RawMessage
	if params != nil {
		data, err := json.Marshal(params)
		if err != nil {
			return err
		}
		raw = data
	}
	id := c.nextID.Add(1)
	payload, err := json.Marshal(Request{ID: id, Method: method, Params: raw})
	if err != nil {
		return err
	}
	payload = append(payload, '\n')

	var conn *connection
	var ch chan Response
	for attempt := 0; ; attempt++ {
		conn, err = c.connection(ctx, attempt > 0)
		if err != nil {
			return err
		}
		ch = make(chan Response, 1)
		conn.mu.Lock()
		conn.pending[id] = ch
		conn.mu.Unlock()
		conn.writeMu.Lock()
		_, err = conn.conn.Write(payload)
		conn.writeMu.Unlock()
		if err == nil {
			break
		}
		conn.mu.Lock()
		delete(conn.pending, id)
		conn.mu.Unlock()
		if attempt > 0 {
			return fmt.Errorf("write to bridge: %w", err)
		}
	}
	select {
	case response := <-ch:
		if response.Error != nil {
			return response.Error
		}
		if out != nil && len(response.Result) > 0 {
			return json.Unmarshal(response.Result, out)
		}
		return nil
	case <-ctx.Done():
		conn.mu.Lock()
		delete(conn.pending, id)
		conn.mu.Unlock()
		return ctx.Err()
	}
}

// Ping checks that the extension answers.
func (c *Client) Ping(ctx context.Context) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var info map[string]any
	if err := c.Call(ctx, "ping", nil, &info); err != nil {
		return nil, err
	}
	return info, nil
}
