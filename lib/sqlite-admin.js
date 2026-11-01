const express = require("express")
const sqlite3 = require("sqlite3").verbose()
const fs = require("fs")
const path = require("path")
const crypto = require("crypto")

const router = express.Router()
const DB_DIR = process.env.DB_DIR || "/home3/tunujournl"
const USER = process.env.DB_VIEWER_USER
const PASS = process.env.DB_VIEWER_PASS

function decodeHTML(value) {
    return String(value ?? "").replace(/&amp;/g, "&").replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&#([0-9]+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

router.use((req, res, next) => {
    const auth = req.headers.authorization || ""
    const [type, token] = auth.split(" ")

    if (type !== "Basic" || !token) {
        res.set("WWW-Authenticate", 'Basic realm="SQLite Admin"')
        return res.status(401).send("Authentication required")
    }

    let credentials

    try {
        credentials = Buffer.from(token, "base64").toString()
    } catch {
        return res.sendStatus(401)
    }

    const index = credentials.indexOf(":")
    const username = credentials.slice(0, index)
    const password = credentials.slice(index + 1)

    const valid = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))

    if (index < 0 || !valid(username, USER) || !valid(password, PASS))
        return res.sendStatus(401)

    next()
})

function getDatabases() {
    const found = []
    const excludedFiles = ["dns_cache", ".rcube.db"]
    const excludedDirs = ["tmp", "etc", "ssl", "node_modules", "mail", "public_html"]

    function scan(dir, depth = 0) {
        if (depth > 6) return

        let items

        try {
            items = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
            return
        }

        for (const item of items) {
            if (excludedDirs.includes(item.name)) continue
            if (item.name.startsWith(".") && item.name !== ".rcube.db") continue
            if (excludedFiles.includes(item.name)) continue

            const file = path.join(dir, item.name)

            if (item.isDirectory()) {
                scan(file, depth + 1)
            } else if (/\.(db|sqlite|sqlite3)$/i.test(item.name)) {
                found.push(path.resolve(file))
            }
        }
    }

    scan(path.resolve(DB_DIR))
    return Array.from(new Set(found))
}

function openDatabase(file, mode = sqlite3.OPEN_READWRITE) {
    const resolved = path.resolve(file)
    const allowed = getDatabases()

    if (!allowed.includes(resolved))
        throw new Error("Database not allowed")

    return new sqlite3.Database(resolved, mode)
}

router.get("/", (req, res) => {
    const dbs = getDatabases()

    res.send(`<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SQLite Admin</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#0b0b13;color:#e2e8f0;font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.5}header{padding:24px 32px;background:#12121c;border-bottom:1px solid #222232;display:flex;justify-content:space-between;align-items:center}h2{margin:0;color:#f3e8ff;font-size:20px;font-weight:600}main{padding:32px;max-width:1200px;margin:auto}.card{background:#12121c;border:1px solid #222232;border-radius:16px;padding:24px;margin-bottom:24px;box-shadow:0 4px 20px rgba(0,0,0,0.3)}button{background:linear-gradient(135deg,#9333ea,#a855f7);color:white;border:0;padding:10px 18px;border-radius:8px;cursor:pointer;font-weight:500;transition:opacity 0.2s}button:hover{opacity:0.9}input,textarea,select{background:#0b0b13;color:#f8fafc;border:1px solid #2d2d3d;padding:12px;border-radius:8px;width:100%;margin:8px 0;font-family:inherit;outline:none;transition:border-color 0.2s}input:focus,textarea:focus,select:focus{border-color:#a855f7}a{color:#d8b4fe;text-decoration:none;transition:color 0.2s}a:hover{color:#f3e8ff}.db-item{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:#181824;border:1px solid #252535;border-radius:10px;margin-bottom:10px;transition:transform 0.1s,background 0.1s}.db-item:hover{background:#1e1e2d;transform:translateY(-1px)}.db-path{max-width:650px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.db-info{overflow:hidden}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#0b0b13;padding:16px;border-radius:10px;border:1px solid #2d2d3d;font-family:ui-monospace,monospace;font-size:13px;color:#cbd5e1}.muted{color:#94a3b8;font-size:13px}.row{display:flex;gap:12px}
</style>
</head>
<body>
<header><h2>SQLite Admin</h2><span class="muted">Secure Database Manager</span></header>
<main>
<div class="card">
<h3 style="margin-top:0;color:#f3e8ff;font-size:16px;margin-bottom:16px">Databases</h3>
${dbs.map((db, i) => `<div class="db-item"><div class="db-info"><a href="/db/database/${i}" style="font-weight:500">${path.basename(db)}</a><div class="muted db-path" style="font-size:11px;margin-top:2px" title="${db}">${db}</div></div><a href="/db/api/backup/${i}" style="font-size:12px;background:#262638;padding:6px 12px;border-radius:6px;color:#e2e8f0;border:1px solid #36364a;flex-shrink:0;margin-left:12px">Download</a></div>`).join("") || "<p class='muted'>No databases found</p>"}
</div>
<div class="card">
<h3 style="margin-top:0;color:#f3e8ff;font-size:16px;margin-bottom:16px">SQL Query Console</h3>
<select id="database">
${dbs.map((db, i) => `<option value="${i}">${path.basename(db)}</option>`).join("")}
</select>
<textarea id="sql" rows="5" placeholder="SELECT * FROM sqlite_master"></textarea>
<div class="row"><button onclick="query()">Execute Query</button></div>
<pre id="result"></pre>
</div>
</main>
<script>
async function query() {
    const result = document.getElementById("result")
    result.textContent = "Executing..."
    try {
        const r = await fetch("/db/api/query", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ database: document.getElementById("database").value, sql: document.getElementById("sql").value })
        })
        const data = await r.json()
        result.textContent = JSON.stringify(data, null, 2)
    } catch (e) {
        result.textContent = e.message
    }
}
</script>
</body>
</html>`)
})

router.get("/database/:id", (req, res) => {
    const dbs = getDatabases()
    const file = dbs[Number(req.params.id)]

    if (!file) return res.sendStatus(404)

    let db
    try {
        db = openDatabase(file, sqlite3.OPEN_READONLY)
    } catch {
        return res.sendStatus(403)
    }

    db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name", (err, tables) => {
        db.close()

        if (err) return res.status(500).send(err.message)

        res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${path.basename(file)}</title><style>*{box-sizing:border-box}body{margin:0;background:#0b0b13;color:#e2e8f0;font-family:system-ui,-apple-system,sans-serif;font-size:14px;padding:32px;max-width:900px;margin:auto}a{color:#d8b4fe;text-decoration:none}h2{color:#f3e8ff;margin-bottom:4px}ul{padding:0;list-style:none;margin-top:20px}li{background:#12121c;border:1px solid #222232;border-radius:10px;margin-bottom:10px;transition:background 0.1s}li:hover{background:#181824}li a{display:block;padding:14px 18px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.muted{color:#94a3b8;font-size:13px}</style></head><body><h2>${path.basename(file)}</h2><p><a href="/db">← Back to Databases</a></p><h3 style="color:#f3e8ff;margin-top:24px">Tables</h3><ul>${tables.map(t => `<li><a href="/db/table/${req.params.id}/${encodeURIComponent(t.name)}">${t.name}</a></li>`).join("") || "<p class='muted'>No tables found</p>"}</ul></body></html>`)
    })
})

router.get("/table/:id/:table", (req, res) => {
    const dbs = getDatabases()
    const file = dbs[Number(req.params.id)]
    if (!file) return res.sendStatus(404)

    let table
    try {
        table = decodeURIComponent(req.params.table)
    } catch {
        return res.sendStatus(400)
    }

    let db
    try {
        db = openDatabase(file, sqlite3.OPEN_READONLY)
    } catch {
        return res.sendStatus(403)
    }

    db.all(`PRAGMA table_info("${table.replace(/"/g, '""')}")`, (err, tableInfo) => {
        if (err) {
            db.close()
            return res.sendStatus(404)
        }

        const pkCol = tableInfo.find(col => col.pk > 0)
        const hasRowidOrPk = pkCol || tableInfo.some(col => col.name.toLowerCase() === 'id')
        const selectIdCol = pkCol ? pkCol.name : (tableInfo.some(col => col.name.toLowerCase() === 'id') ? 'id' : 'rowid')

        db.all(`SELECT ${selectIdCol} AS __rowid__, * FROM "${table.replace(/"/g, '""')}" LIMIT 500`, (error, rows) => {
            db.close()

            if (error) return res.status(400).send(error.message)

            const columns = rows.length ? Object.keys(rows[0]).filter(k => k !== '__rowid__') : tableInfo.map(c => c.name)

            res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${table}</title><style>*{box-sizing:border-box}body{margin:0;background:#0b0b13;color:#e2e8f0;font-family:system-ui,-apple-system,sans-serif;font-size:13px;padding:32px}a{color:#d8b4fe;text-decoration:none}input,select{background:#12121c;color:#f8fafc;border:1px solid #2d2d3d;padding:12px;border-radius:8px;width:100%;margin-bottom:16px;font-family:inherit;outline:none}input:focus,select:focus{border-color:#a855f7}table{border-collapse:collapse;width:100%;table-layout:fixed}td,th{border-bottom:1px solid #222232;padding:12px 16px;text-align:left;width:200px;min-width:200px}td{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}th{background:#12121c;color:#f3e8ff;cursor:pointer;position:sticky;top:0;z-index:1;font-weight:600;white-space:nowrap}th:hover{background:#1a1a28}tr{cursor:pointer}tr.selected{background:#26203a !important}tr:hover{background:#151522}div.table-container{overflow:auto;max-height:75vh;border:1px solid #222232;border-radius:12px;background:#12121c;box-shadow:0 4px 20px rgba(0,0,0,0.3)}.header-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}.muted{color:#94a3b8;font-size:13px}h2{color:#f3e8ff;margin:0 0 4px 0}#contextMenu{display:none;position:absolute;background:#181824;border:1px solid #2d2d3d;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.5);z-index:1000;padding:4px 0}#contextMenu div{padding:10px 20px;cursor:pointer;color:#e2e8f0}#contextMenu div:hover{background:#262638;color:#f3e8ff}.modal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);justify-content:center;align-items:center;z-index:2000}.modal-content{background:#12121c;border:1px solid #2d2d3d;padding:24px;border-radius:12px;width:400px;max-width:90%}.modal-buttons{display:flex;justify-content:flex-end;gap:10px;margin-top:16px}button.btn{background:linear-gradient(135deg,#9333ea,#a855f7);color:white;border:0;padding:8px 16px;border-radius:6px;cursor:pointer}button.btn-secondary{background:#262638;color:#e2e8f0}</style></head><body><div class="header-row"><div><h2>Table: ${table}</h2><p style="margin:0"><a href="/db/database/${req.params.id}">← Back to Tables</a> <span class="muted">| ${rows.length} records loaded (Click row to select, right-click for options)</span></p></div></div><input type="text" id="search" placeholder="Filter rows..." onkeyup="filterRows()"><div class="table-container"><table id="dataTable"><thead><tr>${columns.map((k, idx) => `<th onclick="sortTable(${idx})">${String(k).replace(/</g, "&lt;")} ↕</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr data-rowid="${row.__rowid__ ?? ''}" onclick="selectRow(this, event)"><touser>${Object.entries(row).filter(([k]) => k !== '__rowid__').map(([k, v]) => {
                const rawVal = decodeHTML(v ?? "NULL").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                const displayVal = rawVal.length > 100 ? rawVal.slice(0, 100) + "..." : rawVal;
                const fullVal = String(v ?? "NULL").replace(/"/g, '&quot;');
                return `<td data-col="${k}" title="${fullVal}">${displayVal}</td>`;
            }).join("")}</touser></tr>`).join("")}</tbody></table></div><div id="contextMenu"><div onclick="editRow()">Edit Row</div><div onclick="deleteRow()" style="color:#f87171">Delete Row</div></div><div id="editModal" class="modal"><div class="modal-content"><h3 style="margin-top:0;color:#f3e8ff">Edit Row</h3><div id="editFormFields" style="max-height:50vh;overflow-y:auto"></div><div class="modal-buttons"><button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn" onclick="saveRow()">Save Changes</button></div></div></div><script>let selectedRow=null;const menu=document.getElementById("contextMenu");document.addEventListener("click",()=>menu.style.display="none");function selectRow(tr, e){document.querySelectorAll("#dataTable tbody tr").forEach(r=>r.classList.remove("selected"));tr.classList.add("selected");selectedRow=tr;}document.querySelectorAll("#dataTable tbody tr").forEach(tr=>{tr.addEventListener("contextmenu",e=>{e.preventDefault();selectRow(tr, e);menu.style.top=e.pageY+"px";menu.style.left=e.pageX+"px";menu.style.display="block"})});function filterRows(){const q=document.getElementById("search").value.toLowerCase();const trs=document.querySelectorAll("#dataTable tbody tr");trs.forEach(tr=>{const text=tr.textContent.toLowerCase();tr.style.display=text.includes(q)?"":"none"})}function sortTable(colIndex){const table=document.getElementById("dataTable");const tbody=table.tBodies[0];const rowsArray=Array.from(tbody.rows);const isAsc=table.dataset.sortDir!=="asc";table.dataset.sortDir=isAsc?"asc":"desc";rowsArray.sort((a,b)=>{const aText=a.cells[colIndex].textContent.trim();const bText=b.cells[colIndex].textContent.trim();const aNum=Number(aText);const bNum=Number(bNum);if(!isNaN(aNum)&&!isNaN(bNum)){return isAsc?aNum-bNum:bNum-aNum}return isAsc?aText.localeCompare(bText):bText.localeCompare(aText)});rowsArray.forEach(row=>tbody.appendChild(row))}function editRow(){if(!selectedRow)return;menu.style.display="none";const modal=document.getElementById("editModal");const container=document.getElementById("editFormFields");container.innerHTML="";const tds=selectedRow.querySelectorAll("td");const headers=Array.from(document.querySelectorAll("#dataTable th")).map(th=>th.textContent.replace(" ↕","").trim());tds.forEach((td, idx)=>{const colName=headers[idx];const val=td.getAttribute("title")!=="NULL"?td.getAttribute("title"):"";container.innerHTML+='<label style="font-size:12px;color:#94a3b8">'+colName+'</label><input type="text" data-col="'+colName+'" value="'+val.replace(/"/g, '&quot;')+'">'});modal.style.display="flex"}function closeModal(){document.getElementById("editModal").style.display="none"}async function saveRow(){if(!selectedRow)return;const inputs=document.querySelectorAll("#editFormFields input");const rowid=selectedRow.dataset.rowid;const data={};inputs.forEach(inp=>{data[inp.dataset.col]=inp.value});const r=await fetch("/db/api/query",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({database:${req.params.id},sql:null,action:"update",table:"${table}",rowid:rowid,data:data,idCol:"${selectIdCol}"})});const res=await r.json();if(res.error){alert("Error: "+res.error)}else{alert("Row updated successfully");location.reload()}}async function deleteRow(){if(!selectedRow)return;if(!confirm("Delete this row?"))return;menu.style.display="none";const rowid=selectedRow.dataset.rowid;const r=await fetch("/db/api/query",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({database:${req.params.id},sql:null,action:"delete",table:"${table}",rowid:rowid,idCol:"${selectIdCol}"})});const res=await r.json();if(res.error){alert("Error: "+res.error)}else{selectedRow.remove();alert("Row deleted successfully")}}</script></body></html>`)
        })
    })
})

router.post("/api/query", express.json(), (req, res) => {
    const id = Number(req.body.database)
    const dbs = getDatabases()
    if (!Number.isInteger(id) || !dbs[id])
        return res.status(400).json({ error: "Invalid database" })

    let db
    try {
        db = openDatabase(dbs[id], sqlite3.OPEN_READWRITE)
    } catch {
        return res.status(403).json({ error: "Database not allowed" })
    }

    if (req.body.action === "delete") {
        const table = req.body.table
        const rowid = req.body.rowid
        const idCol = req.body.idCol || "rowid"
        const safeTable = table.replace(val => val, table) // placeholder safely handled via interpolation or parameters
        
        const sql = idCol === "rowid" 
            ? `DELETE FROM "${table.replace(/"/g, '""')}" WHERE rowid = ?`
            : `DELETE FROM "${table.replace(/"/g, '""')}" WHERE "${idCol.replace(/"/g, '""')}" = ?`

        db.run(sql, [rowid], function(err) {
            db.close()
            if (err) return res.status(400).json({ error: err.message })
            res.json({ count: this.changes })
        })
        return
    }

    if (req.body.action === "update") {
        const table = req.body.table
        const rowid = req.body.rowid
        const idCol = req.body.idCol || "rowid"
        const data = req.body.data || {}

        const keys = Object.keys(data)
        if (!keys.length) {
            db.close()
            return res.status(400).json({ error: "No data provided" })
        }

        const setClause = keys.map(k => `"${k.replace(/"/g, '""')}" = ?`).join(", ")
        const values = Object.values(data)
        values.push(rowid)

        const sql = idCol === "rowid"
            ? `UPDATE "${table.replace(/"/g, '""')}" SET ${setClause} WHERE rowid = ?`
            : `UPDATE "${table.replace(/"/g, '""')}" SET ${setClause} WHERE "${idCol.replace(/"/g, '""')}" = ?`

        db.run(sql, values, function(err) {
            db.close()
            if (err) return res.status(400).json({ error: err.message })
            res.json({ count: this.changes })
        })
        return
    }

    const sql = String(req.body.sql || "").trim()
    if (!sql) return res.status(400).json({ error: "Invalid request" })

    if (!/^(SELECT|PRAGMA|EXPLAIN|DELETE|UPDATE|INSERT)\b/i.test(sql))
        return res.status(403).json({ error: "Query not allowed" })

    const isWrite = /^(DELETE|UPDATE|INSERT)\b/i.test(sql)
    const method = isWrite ? "run" : "all"

    db[method](sql, function(err, rows) {
        db.close()

        if (err) return res.status(400).json({ error: err.message })

        res.json({ count: rows ? rows.length : (this.changes || 0), rows: rows || [] })
    })
})

router.get("/api/backup/:id", (req, res) => {
    const dbs = getDatabases()
    const file = dbs[Number(req.params.id)]

    if (!file) return res.sendStatus(404)

    res.download(file, path.basename(file))
})

module.exports = router