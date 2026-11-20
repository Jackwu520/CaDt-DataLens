// service：spike 的 Go 服务（Wails v3 NewService 绑定）。
// 依赖全部经配置注入，避免服务包反向依赖 main。
package service

// Deps 是服务需要的宿主能力（窗口操作、日志）。
type Deps struct {
	Logf func(format string, args ...any)

	// EmitPing 从主窗口对象发射定向事件，返回一句话结果供 JS 显示。
	EmitPing func() string
	// OpenFloat 创建（或聚焦）第二个窗口。
	OpenFloat func() string
	// CloseFloat 关闭第二个窗口。
	CloseFloat func() string
	// ExecJSProbe 只向主窗口 ExecJS 写一个一次性标记，用于证明每窗口 JS context 独立。
	ExecJSProbe func() string
	// ProbeState 返回进程内已知的窗口信息。
	ProbeState func() map[string]any
}

// Service 是绑定给前端的服务，方法名即 binding 方法名。
type Service struct {
	deps Deps
}

// New 构造服务。
func New(deps Deps) *Service { return &Service{deps: deps} }

// Report 接收前端上报（日志落盘），用于验证 JS → Go 绑定调用链。
func (s *Service) Report(window, msg string) {
	s.deps.Logf("[js:%s] %s", window, msg)
}

// EmitPing 从主窗口对象发射一次事件（验证 window.EmitEvent 是否真定向）。
func (s *Service) EmitPing() string { return s.deps.EmitPing() }

// EmitPingFromFloat 从浮窗对象发射一次事件。
func (s *Service) EmitPingFromFloat() string { return s.deps.EmitPing() }

// OpenFloat 创建第二个窗口（验证一进程多窗口 + 独立 JS context）。
func (s *Service) OpenFloat() string { return s.deps.OpenFloat() }

// CloseFloat 关闭第二个窗口。
func (s *Service) CloseFloat() string { return s.deps.CloseFloat() }

// ExecJSProbe 只给主窗口写标记（验证 per-window JS context）。
func (s *Service) ExecJSProbe() string { return s.deps.ExecJSProbe() }

// ProbeState 返回窗口信息供前端显示。
func (s *Service) ProbeState() map[string]any { return s.deps.ProbeState() }
