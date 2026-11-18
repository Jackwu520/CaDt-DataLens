// graphglyph.go：`git log --graph` 字形流解析器。
// 设计沿 Industry 成熟路线（Gitea gitgraph parser，MIT，© 2020 The Gitea Authors 移植：
// https://github.com/go-gitea/gitea/blob/main/services/repository/gitgraph/parser.go）：
// 不自己实现泳道布局算法——git 的 graph.c 是唯一权威实现，`git log --graph` 直接输出
// 每行的字形矩阵（'*' 提交点、'|' 纵线、'/' '\' 斜线、'_' '-' 横线），
// 这里只做两件事：①按连通性规则给每条 flow（分支线）继承/分配色号；②记录每行字形。
// 上层（graph.go）把同一提交的「提交行 + 关系行」压缩成 flow 路径交给前端渲染。
package gitinfo

// glyphParser 是有状态解析器：跨行追踪每条 flow 的字形与色号。
type glyphParser struct {
	glyphs    []byte // 当前行字形
	oldGlyphs []byte // 上一行字形
	flows     []int64
	oldFlows  []int64
	maxFlow   int64
	colors    []int
	oldColors []int
	// 可复用色号环：flow 结束后色号回收再利用（Gitea 同款算法）
	availableColors  []int
	nextAvailable    int
	firstInUse       int
	firstAvailable   int
	maxAllowedColors int
}

func newGlyphParser() *glyphParser {
	p := &glyphParser{}
	p.reset()
	return p
}

func (p *glyphParser) reset() {
	p.glyphs = p.glyphs[0:0]
	p.oldGlyphs = p.oldGlyphs[0:0]
	p.flows = p.flows[0:0]
	p.oldFlows = p.oldFlows[0:0]
	p.maxFlow = 0
	p.colors = p.colors[0:0]
	p.oldColors = p.oldColors[0:0]
	p.availableColors = p.availableColors[0:0]
	p.availableColors = append(p.availableColors, 1, 2)
	p.nextAvailable = 0
	p.firstInUse = -1
	p.firstAvailable = 0
	p.maxAllowedColors = 0
}

// parse 解析一行字形并更新内部状态；结果在 p.glyphs / p.flows / p.colors 里。
func (p *glyphParser) parse(glyphs []byte) {
	// 换行：当前行变上一行
	p.glyphs, p.oldGlyphs = p.oldGlyphs, p.glyphs
	p.glyphs = p.glyphs[0:0]
	p.flows, p.oldFlows = p.oldFlows, p.flows
	p.flows = p.flows[0:0]
	p.colors, p.oldColors = p.oldColors, p.colors
	p.colors = p.colors[0:0]
	for range glyphs {
		p.flows = append(p.flows, 0)
		p.colors = append(p.colors, 0)
	}
	p.glyphs = append(p.glyphs, glyphs...)

	p.releaseUnusedColors()

	// 从右往左扫：右边的字形先定 flow，左边才能继承（Gitea 同款顺序）
	for i := len(glyphs) - 1; i >= 0; i-- {
		switch glyphs[i] {
		case '|', '*':
			p.setUpFlow(i)
		case '/':
			p.setOutFlow(i)
		case '\\':
			p.setInFlow(i)
		case '_':
			p.setRightFlow(i)
		case '.', '-':
			p.setLeftFlow(i)
		case ' ':
			// 空格：跳过
		default:
			p.newFlow(i)
		}
	}
}

func (p *glyphParser) takePreviousFlow(i, j int) {
	if j < len(p.oldFlows) && p.oldFlows[j] > 0 {
		p.flows[i] = p.oldFlows[j]
		p.oldFlows[j] = 0
		p.colors[i] = p.oldColors[j]
		p.oldColors[j] = 0
	} else {
		p.newFlow(i)
	}
}

func (p *glyphParser) takeCurrentFlow(i, j int) {
	if j < len(p.flows) && p.flows[j] > 0 {
		p.flows[i] = p.flows[j]
		p.colors[i] = p.colors[j]
	} else {
		p.newFlow(i)
	}
}

func (p *glyphParser) newFlow(i int) {
	p.maxFlow++
	p.flows[i] = p.maxFlow

	// 分配色号：优先从回收环里取（flow 结束时色号被 releaseUnusedColors 归位）
	if p.nextAvailable == -1 {
		next := len(p.availableColors)
		if p.maxAllowedColors < 1 || next < p.maxAllowedColors {
			p.nextAvailable = next
			p.firstAvailable = next
			p.availableColors = append(p.availableColors, next+1)
		}
	}
	p.colors[i] = p.availableColors[p.nextAvailable]
	if p.firstInUse == -1 {
		p.firstInUse = p.nextAvailable
	}
	p.availableColors[p.firstAvailable], p.availableColors[p.nextAvailable] = p.availableColors[p.nextAvailable], p.availableColors[p.firstAvailable]

	p.nextAvailable = (p.nextAvailable + 1) % len(p.availableColors)
	p.firstAvailable = (p.firstAvailable + 1) % len(p.availableColors)

	if p.nextAvailable == p.firstInUse {
		p.nextAvailable = p.firstAvailable
	}
	if p.nextAvailable == p.firstInUse {
		p.nextAvailable = -1
		p.firstAvailable = -1
	}
}

// setUpFlow 处理 '|' 与 '*'（纵线/提交点）
func (p *glyphParser) setUpFlow(i int) {
	// 上一行优先级：'\?' ' |' '  /'  → 本行 '|'
	if i > 0 && i-1 < len(p.oldGlyphs) && p.oldGlyphs[i-1] == '\\' {
		p.takePreviousFlow(i, i-1)
	} else if i < len(p.oldGlyphs) && (p.oldGlyphs[i] == '|' || p.oldGlyphs[i] == '*') {
		p.takePreviousFlow(i, i)
	} else if i+1 < len(p.oldGlyphs) && p.oldGlyphs[i+1] == '/' {
		p.takePreviousFlow(i, i+1)
	} else {
		p.newFlow(i)
	}
}

// setOutFlow 处理 '/'（向左下汇入）
func (p *glyphParser) setOutFlow(i int) {
	// 上一行优先级：' |/' ' |_' ' |' ' /' ' _' '\'  → 本行 '/| ' '/| ' '/ ' '/ ' '/ ' '/'
	if i+2 < len(p.oldGlyphs) &&
		(p.oldGlyphs[i+1] == '|' || p.oldGlyphs[i+1] == '*') &&
		(p.oldGlyphs[i+2] == '/' || p.oldGlyphs[i+2] == '_') &&
		i+1 < len(p.glyphs) &&
		(p.glyphs[i+1] == '|' || p.glyphs[i+1] == '*') {
		p.takePreviousFlow(i, i+2)
	} else if i+1 < len(p.oldGlyphs) &&
		(p.oldGlyphs[i+1] == '|' || p.oldGlyphs[i+1] == '*' ||
			p.oldGlyphs[i+1] == '/' || p.oldGlyphs[i+1] == '_') {
		p.takePreviousFlow(i, i+1)
		if p.oldGlyphs[i+1] == '/' {
			p.glyphs[i] = '|'
		}
	} else if i < len(p.oldGlyphs) && p.oldGlyphs[i] == '\\' {
		p.takePreviousFlow(i, i)
	} else {
		p.newFlow(i)
	}
}

// setInFlow 处理 '\'（向右下分叉/延续）
func (p *glyphParser) setInFlow(i int) {
	// 上一行优先级：'| ' '-. ' '| ' '\ ' '/' '---'  → 本行 '|\' '  \' ' \' ' \' '\' ' \ '
	if i > 0 && i-1 < len(p.oldGlyphs) &&
		(p.oldGlyphs[i-1] == '|' || p.oldGlyphs[i-1] == '*') &&
		(p.glyphs[i-1] == '|' || p.glyphs[i-1] == '*') {
		// 左侧是贯通纵线 + 本行圆点/纵线：这是分叉点，新 flow
		p.newFlow(i)
	} else if i > 0 && i-1 < len(p.oldGlyphs) &&
		(p.oldGlyphs[i-1] == '|' || p.oldGlyphs[i-1] == '*' ||
			p.oldGlyphs[i-1] == '.' || p.oldGlyphs[i-1] == '\\') {
		p.takePreviousFlow(i, i-1)
		if p.oldGlyphs[i-1] == '\\' {
			p.glyphs[i] = '|'
		}
	} else if i < len(p.oldGlyphs) && p.oldGlyphs[i] == '/' {
		p.takePreviousFlow(i, i)
	} else {
		p.newFlow(i)
	}
}

// setRightFlow 处理 '_'（横线，八叉合并用）
func (p *glyphParser) setRightFlow(i int) {
	// 本行优先级：'__' '_/' '_|_' '_|/'
	if i+1 < len(p.glyphs) &&
		(p.glyphs[i+1] == '_' || p.glyphs[i+1] == '/') {
		p.takeCurrentFlow(i, i+1)
	} else if i+2 < len(p.glyphs) &&
		(p.glyphs[i+1] == '|' || p.glyphs[i+1] == '*') &&
		(p.glyphs[i+2] == '_' || p.glyphs[i+2] == '/') {
		p.takeCurrentFlow(i, i+2)
	} else {
		p.newFlow(i)
	}
}

// setLeftFlow 处理 '-' 与 '.'（横线收尾）
func (p *glyphParser) setLeftFlow(i int) {
	if p.glyphs[i] == '.' {
		p.newFlow(i)
	} else if i+1 < len(p.glyphs) &&
		(p.glyphs[i+1] == '-' || p.glyphs[i+1] == '.') {
		p.takeCurrentFlow(i, i+1)
	} else {
		p.newFlow(i)
	}
}

// releaseUnusedColors 把已结束 flow 的色号回收到环前端（Gitea 同款实现）。
func (p *glyphParser) releaseUnusedColors() {
	if p.firstInUse > -1 {
		stepstaken := 0
		position := p.firstInUse
		for _, color := range p.oldColors {
			if color == 0 {
				continue
			}
			found := false
			i := position
			for j := stepstaken; i != p.firstAvailable && j < len(p.availableColors); j++ {
				colorToCheck := p.availableColors[i]
				if colorToCheck == color {
					found = true
					break
				}
				i = (i + 1) % len(p.availableColors)
			}
			if !found {
				// 重复色号，跳过
				continue
			}
			p.availableColors[position], p.availableColors[i] = p.availableColors[i], p.availableColors[position]
			stepstaken++
			position = (p.firstInUse + stepstaken) % len(p.availableColors)
			if position == p.firstAvailable || stepstaken == len(p.availableColors) {
				break
			}
		}
		if stepstaken == len(p.availableColors) {
			p.firstAvailable = -1
		} else {
			p.firstAvailable = position
			if p.nextAvailable == -1 {
				p.nextAvailable = p.firstAvailable
			}
		}
	}
}
