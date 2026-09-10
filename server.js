const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = 8848; //端口号，请确保没有占用
const SAVED_DIR = path.join(__dirname, 'saved');
const CLASSES_FILE = path.join(__dirname, 'classes.json');
const INITIAL_CODE_FILE = path.join(__dirname, 'public', 'index.html');

if (!fs.existsSync(SAVED_DIR)) {
    fs.mkdirSync(SAVED_DIR);
}

let classes;
try {
    const raw = fs.readFileSync(CLASSES_FILE, 'utf8');
    const config = JSON.parse(raw);

    let initialCode = '<h1>欢迎</h1>';
    try {
        initialCode = fs.readFileSync(INITIAL_CODE_FILE, 'utf8');
    } catch (err) {
        console.warn('未找到 index.html，使用默认初始代码');
    }

    classes = {};
    for (const [className, groups] of Object.entries(config)) {
        classes[className] = {};
        for (const [groupName, setting] of Object.entries(groups)) {
            if (!setting.students || !Array.isArray(setting.students)) {
                console.error(`配置错误：${className}/${groupName} 缺少 students 数组`);
                process.exit(1);
            }
            classes[className][groupName] = {
                students: setting.students,
                maxUsers: setting.maxUsers || setting.students.length,
                currentCode: initialCode
            };
        }
    }

    // 从磁盘恢复已保存的代码
    for (const [className, groups] of Object.entries(classes)) {
        for (const groupName of Object.keys(groups)) {
            const filePath = path.join(SAVED_DIR, `${className}_${groupName}.html`);
            if (fs.existsSync(filePath)) {
                try {
                    const savedCode = fs.readFileSync(filePath, 'utf8');
                    classes[className][groupName].currentCode = savedCode;
                    console.log(`已恢复代码: ${className}_${groupName}`);
                } catch (err) {
                    console.error(`读取 ${filePath} 失败，仍使用初始代码`);
                }
            }
        }
    }

    console.log('已加载班级配置，班级数量：', Object.keys(classes).length);
} catch (err) {
    console.error('读取 classes.json 失败：', err.message);
    process.exit(1);
}

const rooms = {};
const userGroups = new Map();
const ipToWs = new Map();

const server = http.createServer((req, res) => {
    let urlPath = req.url === '/' ? '/index.html' : req.url;
    if (urlPath.includes('..')) {
        res.writeHead(403);
        return res.end('Forbidden');
    }
    let filePath = path.join(__dirname, 'public', urlPath);
    if (!fs.existsSync(filePath)) {
        filePath = path.join(__dirname, urlPath);
    }
    const ext = path.extname(filePath);
    const mime = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript',
        '.css': 'text/css'
    };
    const headers = {
        'Content-Type': mime[ext] || 'text/plain',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    };
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, headers);
            res.end('Not Found');
        } else {
            res.writeHead(200, headers);
            res.end(data);
        }
    });
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    ws.clientIp = req.socket.remoteAddress?.replace(/^::ffff:/, '') || 'unknown';
    let currentRoom = null;
    let currentStudentName = null;
    ws.isLeader = false;   // ★ 新增强制初始值

    ws.on('message', (message) => {
        let msg;
        try {
            msg = JSON.parse(message);
        } catch (e) {
            return;
        }

        switch (msg.type) {
            case 'getClassList': {
                const list = {};
                for (const [className, groups] of Object.entries(classes)) {
                    list[className] = Object.keys(groups);
                }
                ws.send(JSON.stringify({ type: 'classList', classes: list }));
                break;
            }

            case 'login': {
                const existingWs = ipToWs.get(ws.clientIp);
                if (existingWs && existingWs.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'error', message: '该电脑已有账号登录，请勿重复打开' }));
                    return;
                }
                const { className, groupName, username, password } = msg;
                const classObj = classes[className];
                if (!classObj) {
                    ws.send(JSON.stringify({ type: 'error', message: '班级不存在' }));
                    return;
                }
                const group = classObj[groupName];
                if (!group) {
                    ws.send(JSON.stringify({ type: 'error', message: '组别不存在' }));
                    return;
                }
                const student = group.students.find(s => s.name === username && s.password === password);
                if (!student) {
                    ws.send(JSON.stringify({ type: 'error', message: '姓名或密码错误' }));
                    return;
                }

                const roomKey = `${className}_${groupName}`;
                if (!rooms[roomKey]) {
                    rooms[roomKey] = new Set();
                }
                if (rooms[roomKey].size >= group.maxUsers) {
                    ws.send(JSON.stringify({ type: 'error', message: '该组人数已满' }));
                    return;
                }

                rooms[roomKey].add(ws);
                userGroups.set(ws, roomKey);
                ipToWs.set(ws.clientIp, ws);
                currentRoom = roomKey;
                currentStudentName = username;
                ws.isLeader = student.isLeader ?? false;  // ★ 保存组长身份

                ws.send(JSON.stringify({
                    type: 'loginSuccess',
                    groupName: roomKey,
                    studentName: username,
                    isLeader: ws.isLeader,
                    code: group.currentCode,
                    onlineCount: rooms[roomKey].size
                }));

                broadcastToRoom(roomKey, {
                    type: 'userCount',
                    count: rooms[roomKey].size
                }, ws);

                console.log(`[${roomKey}] ${username}(${ws.clientIp}) 加入，在线 ${rooms[roomKey].size}`);
                break;
            }

            case 'codeUpdate': {
                if (!currentRoom) return;
                const { code } = msg;
                const [cn, gn] = currentRoom.split('_');
                if (classes[cn] && classes[cn][gn]) {
                    classes[cn][gn].currentCode = code;
                }
                broadcastToRoom(currentRoom, { type: 'codeUpdate', code: code }, ws);
                break;
            }

            case 'saveToServer': {
                if (!currentRoom) return;
                // ★ 权限检查：只有组长可以保存
                if (!ws.isLeader) {
                    ws.send(JSON.stringify({ type: 'saveResult', success: false, message: '只有组长才能保存到服务器' }));
                    return;
                }
                const { code } = msg;
                if (!code) {
                    ws.send(JSON.stringify({ type: 'saveResult', success: false, message: '缺少代码内容' }));
                    return;
                }
                const [cn, gn] = currentRoom.split('_');
                if (classes[cn] && classes[cn][gn]) {
                    classes[cn][gn].currentCode = code;
                }
                const fileName = `${cn}_${gn}.html`;
                const filePath = path.join(SAVED_DIR, fileName);
                fs.writeFile(filePath, code, 'utf8', (err) => {
                    if (err) {
                        ws.send(JSON.stringify({ type: 'saveResult', success: false, message: '服务器保存失败' }));
                    } else {
                        ws.send(JSON.stringify({ type: 'saveResult', success: true, message: `已保存到服务器：${fileName}` }));
                    }
                });
                break;
            }
        }
    });

    ws.on('close', () => {
        if (currentRoom && rooms[currentRoom]) {
            rooms[currentRoom].delete(ws);
            const count = rooms[currentRoom].size;
            broadcastToRoom(currentRoom, { type: 'userCount', count: count });
            if (count === 0) delete rooms[currentRoom];
            console.log(`[${currentRoom}] ${currentStudentName || '某用户'} 离开，在线 ${count}`);
        }
        if (ipToWs.get(ws.clientIp) === ws) {
            ipToWs.delete(ws.clientIp);
        }
        userGroups.delete(ws);
    });
});

function broadcastToRoom(roomKey, message, excludeWs = null) {
    if (!rooms[roomKey]) return;
    const data = JSON.stringify(message);
    rooms[roomKey].forEach(client => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`服务器已启动：http://0.0.0.0:${PORT}`);
    console.log('可用班级：', Object.keys(classes).join(', '));
});