// Package cognition：AI 工作区认知索引引擎——FRAS 卷文件（meta + code）+ baseline/drift 治理。
// 卷是纯文本、每条目一行（模型写模型读）；baseline 与锁由 Go 独占管理。
// 方案见 docs/finished-plans/ai-cognition-index.md；绑定壳在根 cognition_app.go。
package cognition

import "errors"

// 预算常量是唯一权威：meta 卷里的 budget 行只是给模型自查的镜像，Go 读到与常量不一致即拒绝写
// （§3.2）。AOCI 本仓实跑锚点：per-file 粒度天然长到 1010 条 / 520 KB——600 / 256KB 是刻意收紧，
// 大仓必须靠目录条目聚合才装得下；放宽只有改这里的常量（meta 镜像行随 BudgetLine 自动变）。
const (
	EntryBudget = 600
	ByteBudget  = 262144
	// ReadRuneLimit 单次 cognition_read 过滤响应的字符（rune）上限。刻意压在 ai-context-slim
	// 的回包落盘阈值（8 192 字符）之下——越线结果会被挪去 artifact，模型拿到的反而是指针。
	ReadRuneLimit = 7000
	// maxScanFiles drift 清单扫描的文件数上限：超预算走截断并标记（§4.1「超预算走采样并标记」），
	// 数据目录误跑 status 时不会全树爬完。
	maxScanFiles = 5000
	// driftSampleCap drift 报告里每态返回的路径样例上限（总量另计）。
	driftSampleCap = 50
	// MaxEntriesPerCall 单次 cognition_edit 的条目数上限：首建按目录分批（§7 P1-4），
	// 一批一写；超大批次说明模型没按协议来，拒绝让它重读工具描述。
	MaxEntriesPerCall = 50
	// cogIgnoreHintMissing Missing 达到该条数且还没有作用域排除文件时，status 响应
	// 自带作用域排除提示（模型正盯着 Missing 看的时刻给出出口）。小工作区 Missing 少、
	// 逐个建档即可，不催；排除文件已存在说明作用域已收窄，不再提示。
	cogIgnoreHintMissing = 20
	// IgnoreLineBudget / IgnoreLineLen 作用域排除文件的行数 / 单行长度预算（meta 同款
	// 「改大即拒绝」口径）：排除表不是条目卷，100 行足够描述生成物与产物目录。
	IgnoreLineBudget = 100
	IgnoreLineLen    = 200
)

// 目录名（相对工作区根）：卷目录在 .cadt/cognition，锁文件在卷目录**之外**
// （memo.go:139 的约定：目录被移动/回收时锁不失效）。.state/ 由 Go 独占管理，
// cognition_edit 拒绝写它——AI 只管语义条目，治理状态是应用的。
// ignore.txt 是作用域排除文件（gitignore 简化语法，AI 经 cognition_edit 的 ignore 参数
// 整卷替换、用户手工编辑不受限）：在卷目录里意味着天然落进 .cadt 整树排除——
// 它自己永不进清单，也就没有「排除文件被报 Missing」的自指问题。
const (
	DirName    = ".cadt/cognition"
	MetaName   = "meta.txt"
	CodeName   = "code.txt"
	IgnoreName = "ignore.txt"
	StateName  = ".state"
	BaselineNm = "baseline.json"
	LockName   = ".cadt/cognition.lock"
)

// 字段识别用：字段以「空格(或行首) + F/R/A/S + :」自标识，值内禁 TAB 与该序列（§3.2）。
const fieldLetters = "FRAS"

var (
	ErrNoIndex     = errors.New("认知索引未建立")
	ErrCASConflict = errors.New("卷指纹不匹配：另一个窗口已改过卷，请重新 cognition_read 后再 edit")
	ErrBaseMissing = errors.New("缺少 CAS 基准：先 cognition_read（或 cognition_status）拿到当前卷指纹再 edit")
)

// Entry 一条认知条目。Path 保留原始大小写与正斜杠；目录条目以 / 结尾（覆盖「不单列」的成员）。
type Entry struct {
	Path   string   `json:"path"`
	Labels []string `json:"labels,omitempty"`
	F      string   `json:"f,omitempty"` // 职责：这个文件是干什么的
	R      string   `json:"r,omitempty"` // 强关联：必须一起改 / 一起读的路径（逗号分隔）
	A      string   `json:"a,omitempty"` // 对外契约：调用方依赖什么
	S      string   `json:"s,omitempty"` // 暗约束：代码看不出来、违背了会出事的约束
}

// Dir 目录条目。
func (e Entry) Dir() bool { return len(e.Path) > 0 && e.Path[len(e.Path)-1] == '/' }

// PathLine overview 的路径地图行（纯路径 + 标签，不含 FRAS 正文，省 token）。
type PathLine struct {
	Path   string   `json:"path"`
	Labels []string `json:"labels,omitempty"`
	Dir    bool     `json:"dir,omitempty"`
}
