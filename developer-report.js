const express = require("express");
const router = express.Router();
require("dotenv").config();
const { sql, config } = require("../config/db");
const ExcelJS = require("exceljs");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { uploadToCandidateBlob } = require("./blobHelper");

function toEndExclusive(endStr) {
  const d = new Date(endStr + "T00:00:00");
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}


router.get("/api/reports", async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ message: "start & end required" });
    }

    const endExclusive = toEndExclusive(end);

    const pool = await sql.connect(config);

    // ===== 1) Usage =====
    const usageResult = await pool
      .request()
      .input("start", sql.DateTime, new Date(start))
      .input("end", sql.DateTime, new Date(endExclusive)).query(`
WITH UsageData AS (
    SELECT 
        CU.org_id,
        CU.orgdiv_id,
        SUM(CASE WHEN CU.source = 'monster' THEN 1 ELSE 0 END) AS used_mon,
        SUM(CASE WHEN CU.source = 'cb' THEN 1 ELSE 0 END) AS used_cb,
        SUM(CASE WHEN CU.source = 'dice' THEN 1 ELSE 0 END) AS used_dic
    FROM credit_usage CU
    WHERE CU.created_at >= @start
      AND CU.created_at <  @end
    GROUP BY CU.org_id, CU.orgdiv_id
)

SELECT
    O.Organization_name,
    D.division_name,

    -- Allocated
    SUM(ISNULL(W.in_mon,0))  AS in_mon,
    SUM(ISNULL(W.in_cb,0))   AS in_cb,
    SUM(ISNULL(w.in_dice,0)) AS in_dice,

    -- Used
    SUM(ISNULL(U.used_mon,0)) AS used_mon,
    SUM(ISNULL(U.used_cb,0))  AS used_cb,
    SUM(ISNULL(U.used_dic,0)) AS used_dice,

    --  Real Calculated Balance
    SUM(ISNULL(W.in_mon,0)) - SUM(ISNULL(U.used_mon,0)) AS bal_mon,
    SUM(ISNULL(W.in_cb,0))  - SUM(ISNULL(U.used_cb,0))  AS bal_cb,
    SUM(ISNULL(W.in_dice,0)) - SUM(ISNULL(U.used_dic,0)) AS bal_dice

FROM credit_wallet W
INNER JOIN Organization O ON O.id = W.org_id
INNER JOIN org_div D ON D.id = W.orgdiv_id
LEFT JOIN UsageData U 
    ON U.org_id = W.org_id 
    AND U.orgdiv_id = W.orgdiv_id

WHERE W.orgdiv_id IS NOT NULL

GROUP BY 
    O.Organization_name,
    D.division_name

ORDER BY 
    D.division_name,
    O.Organization_name;
  `);

    // ===== 2) Onboardings =====
    const onboardResult = await pool
      .request()
      .input("start", sql.DateTime, new Date(start))
      .input("end", sql.DateTime, new Date(endExclusive)).query(`
        SELECT
    O.Organization_name,
    C.CreatedDate,
    C.OnboardDate,
    M.FirstName,
    M.LastName,

    CAST(
        CASE 
            WHEN ISNULL(X.TotalDocs, 0) = 0 THEN 0
            ELSE (X.UploadedDocs * 100 / X.TotalDocs)
        END
        AS DECIMAL(5,2)
    ) AS PercentComplete

FROM StartOnboarding AS C

LEFT JOIN Organization AS O 
    ON C.OrgID = O.id   

LEFT JOIN candidate AS M 
    ON C.candidate_id = M.candidate_id

OUTER APPLY (
    SELECT
        COUNT(*) AS TotalDocs,
        SUM(
            CASE 
                WHEN JSON_VALUE(D.value, '$.Candidatefile') IS NOT NULL
                     AND JSON_VALUE(D.value, '$.Candidatefile') <> ''
                THEN 1 ELSE 0
            END
        ) AS UploadedDocs
    FROM OPENJSON(C.DocumentRequest) AS CL
    CROSS APPLY (
        SELECT value FROM OPENJSON(CL.value, '$.base')
        UNION ALL
        SELECT value FROM OPENJSON(CL.value, '$.ai')
        UNION ALL
        SELECT value FROM OPENJSON(CL.value, '$.additional')
    ) AS D
) AS X

WHERE
    C.CreatedDate >= @start
    AND C.CreatedDate < @end
    AND ISJSON(C.DocumentRequest) = 1;   --  IMPORTANT

      `);

    // ===== 3) Account Creation =====
    const accountResult = await pool
      .request()
      .input("start", sql.DateTime, new Date(start))
      .input("end", sql.DateTime, new Date(endExclusive)).query(`
        SELECT 
          CONCAT(i.firstName, ' ', i.lastName) AS FullName,
          i.createdTime,
          i.email,
          Organization_name,
          division_name,
          i.RequestedBy
        FROM Users AS i
        INNER JOIN Organization ON i.OrgId = Organization.id
        LEFT JOIN org_div ON i.org_div = org_div.id 
        WHERE i.Active = 1
          AND i.createdTime >= @start
          AND i.createdTime <  @end;
      `);

    // ===== 4) Account Deactivation =====
    const deactivateResult = await pool
      .request()
      .input("start", sql.DateTime, new Date(start))
      .input("end", sql.DateTime, new Date(endExclusive)).query(`
           SELECT 
          CONCAT(i.firstName, ' ', i.lastName) AS FullName,
          i.DeactivatedTime,
          i.email,
          Organization_name,
          i.DeactivateRequestedBy
        FROM Users AS i
        INNER JOIN Organization ON i.OrgId = Organization.id
        WHERE i.Active = 0
        AND i.DeactivatedTime >= @start
        AND i.DeactivatedTime < DATEADD(DAY, 1, @end)
        order by i.DeactivatedTime;
      `);

    return res.json({
      usage: usageResult.recordset || [],
      onboardings: onboardResult.recordset || [],
      AccountCreation: accountResult.recordset || [],
      AccountDeactivate: deactivateResult.recordset || [],
    });
  } catch (e) {
    console.error("reports error:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/export", async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ message: "start & end required" });
    }

    const endExclusive = toEndExclusive(end);
    const pool = await sql.connect(config);

    // ---------------- CREDIT USAGE ----------------
    const usageResult = await pool
      .request()
      .input("start", sql.DateTime, new Date(start))
      .input("end", sql.DateTime, new Date(endExclusive)).query(`
WITH UsageData AS (
    SELECT 
        CU.org_id,
        CU.orgdiv_id,
        SUM(CASE WHEN CU.source = 'monster' THEN 1 ELSE 0 END) AS used_mon,
        SUM(CASE WHEN CU.source = 'cb' THEN 1 ELSE 0 END) AS used_cb,
        SUM(CASE WHEN CU.source = 'dice' THEN 1 ELSE 0 END) AS used_dic
    FROM credit_usage CU
    WHERE CU.created_at >= @start
      AND CU.created_at <  @end
    GROUP BY CU.org_id, CU.orgdiv_id
)

SELECT
    O.Organization_name,
    D.division_name,

    -- Allocated
    SUM(ISNULL(W.in_mon,0))  AS in_mon,
    SUM(ISNULL(W.in_cb,0))   AS in_cb,
    SUM(ISNULL(w.in_dice,0)) AS in_dice,

    -- Used
    SUM(ISNULL(U.used_mon,0)) AS used_mon,
    SUM(ISNULL(U.used_cb,0))  AS used_cb,
    SUM(ISNULL(U.used_dic,0)) AS used_dice,

    --  Real Calculated Balance
    SUM(ISNULL(W.in_mon,0)) - SUM(ISNULL(U.used_mon,0)) AS bal_mon,
    SUM(ISNULL(W.in_cb,0))  - SUM(ISNULL(U.used_cb,0))  AS bal_cb,
    SUM(ISNULL(W.in_dice,0)) - SUM(ISNULL(U.used_dic,0)) AS bal_dice

FROM credit_wallet W
INNER JOIN Organization O ON O.id = W.org_id
INNER JOIN org_div D ON D.id = W.orgdiv_id
LEFT JOIN UsageData U 
    ON U.org_id = W.org_id 
    AND U.orgdiv_id = W.orgdiv_id

WHERE W.orgdiv_id IS NOT NULL

GROUP BY 
    O.Organization_name,
    D.division_name

ORDER BY 
    D.division_name,
    O.Organization_name;
  `);

    const creditUsage = usageResult.recordset || [];

    // ---------------- ACCOUNT CREATION ----------------
    const accountResult = await pool
      .request()
      .input("start", sql.DateTime, new Date(start))
      .input("end", sql.DateTime, new Date(endExclusive)).query(`
        SELECT 
          CONCAT(i.firstName, ' ', i.lastName) AS FullName,
          i.createdTime,
          i.email,
          Organization_name,
          division_name,
          i.RequestedBy
        FROM Users AS i
        INNER JOIN Organization ON i.OrgId = Organization.id
        LEFT JOIN org_div ON i.org_div = org_div.id
        WHERE i.Active = 1
          AND i.createdTime >= @start
          AND i.createdTime <= @end
        ORDER BY i.createdTime;
      `);

    // ---------------- ACCOUNT DEACTIVATION ----------------
    const deactivateResult = await pool
      .request()
      .input("start", sql.DateTime, new Date(start))
      .input("end", sql.DateTime, new Date(endExclusive)).query(`
        SELECT 
          CONCAT(i.firstName, ' ', i.lastName) AS FullName,
          i.DeactivatedTime,
          i.email,
          Organization_name,
          i.DeactivateRequestedBy
        FROM Users AS i
        INNER JOIN Organization ON i.OrgId = Organization.id
        WHERE i.Active = 0
          AND i.DeactivatedTime >= @start
          AND i.DeactivatedTime < DATEADD(DAY, 1, @end)
        ORDER BY i.DeactivatedTime;
      `);

    const accountCreation = accountResult.recordset || [];
    const accountDeactivate = deactivateResult.recordset || [];

    // ---------------- ONBOARDING ----------------
    const onboardResult = await pool
      .request()
      .input("start", sql.DateTime, new Date(start))
      .input("end", sql.DateTime, new Date(endExclusive))
      .query(`
         SELECT
    O.Organization_name,
    C.CreatedDate,
    C.OnboardDate,
    M.FirstName,
    M.LastName,

    CAST(
        CASE 
            WHEN ISNULL(X.TotalDocs, 0) = 0 THEN 0
            ELSE (X.UploadedDocs * 100 / X.TotalDocs)
        END
        AS DECIMAL(5,2)
    ) AS PercentComplete

FROM StartOnboarding AS C

LEFT JOIN Organization AS O 
    ON C.OrgID = O.id   

LEFT JOIN candidate AS M 
    ON C.candidate_id = M.candidate_id

OUTER APPLY (
    SELECT
        COUNT(*) AS TotalDocs,
        SUM(
            CASE 
                WHEN JSON_VALUE(D.value, '$.Candidatefile') IS NOT NULL
                     AND JSON_VALUE(D.value, '$.Candidatefile') <> ''
                THEN 1 ELSE 0
            END
        ) AS UploadedDocs
    FROM OPENJSON(C.DocumentRequest) AS CL
    CROSS APPLY (
        SELECT value FROM OPENJSON(CL.value, '$.base')
        UNION ALL
        SELECT value FROM OPENJSON(CL.value, '$.ai')
        UNION ALL
        SELECT value FROM OPENJSON(CL.value, '$.additional')
    ) AS D
) AS X

WHERE
    C.CreatedDate >= @start
    AND C.CreatedDate < @end
    AND ISJSON(C.DocumentRequest) = 1;   --  IMPORTANT

      `);
    const accountOnboard = onboardResult.recordset || [];

    // -------- SUMMARY (NO "Request from") ----------
    const groupSummary = (rows, companyKey, requestedByKey) => {
      const map = new Map();
      rows.forEach((r) => {
        const company = r[companyKey] || "";
        const reqBy = r[requestedByKey] || "";
        const key = `${company}||${reqBy}`;
        map.set(key, (map.get(key) || 0) + 1);
      });

      return Array.from(map.entries()).map(([key, count], idx) => {
        const [company, reqBy] = key.split("||");
        return {
          Sno: idx + 1,
          CompanyName: company,
          RequestedBy: reqBy,
          Count: count,
        };
      });
    };

    const deactSummary = groupSummary(
      accountDeactivate,
      "Organization_name",
      "DeactivateRequestedBy"
    );

    const wb = new ExcelJS.Workbook();
    wb.creator = "TRS";

    const borderThin = (cell) => {
      cell.border = {
        top: { style: "thin" },
        left: { style: "thin" },
        bottom: { style: "thin" },
        right: { style: "thin" },
      };
    };

    const fill = (cell, argb) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
    };


    const wsCU = wb.addWorksheet("Credit_Usage", {
      views: [{ state: "frozen", ySplit: 2 }],
    });

    wsCU.getRow(1).values = [
      "",
      "",
      "Allocated Month",
      "",
      "",
      "Exhausted Credits",
      "",
      "",
      "Difference",
      "",
      "",
    ];

    wsCU.mergeCells("C1:E1");
    wsCU.mergeCells("F1:H1");
    wsCU.mergeCells("I1:K1");

    wsCU.getRow(1).font = { bold: true };
    wsCU.getRow(1).alignment = { horizontal: "center", vertical: "middle" };

    wsCU.getRow(2).values = [
      "Organization",
      "Division Name",
      "Dice",
      "CB",
      "Monster",
      "UsedDice",
      "UsedCB",
      "UsedMonster",
      "BalDice",
      "BalCB",
      "BalMonster",
    ];
    wsCU.getRow(2).font = { bold: true };
    wsCU.getRow(2).alignment = { horizontal: "center", vertical: "middle" };

    fill(wsCU.getCell("A1"), "FFFFFF");
    fill(wsCU.getCell("B1"), "FFFFFF");
    fill(wsCU.getCell("C1"), "FFF2CC");
    fill(wsCU.getCell("F1"), "FCE4D6");
    fill(wsCU.getCell("I1"), "E2F0D9");

    wsCU.getRow(1).eachCell((c) => borderThin(c));
    wsCU.getRow(2).eachCell((c) => borderThin(c));

    wsCU.getColumn(1).width = 22;
    wsCU.getColumn(2).width = 22;
    for (let i = 3; i <= 11; i++) wsCU.getColumn(i).width = 12;

    let totalInDice = 0,
      totalInCb = 0,
      totalInMon = 0;
    let totalUsedDice = 0,
      totalUsedCb = 0,
      totalUsedMon = 0;
    let totalBalDice = 0,
      totalBalCb = 0,
      totalBalMon = 0;

    creditUsage.forEach((r) => {
      totalInDice += r.in_dice;
      totalInCb += r.in_cb;
      totalInMon += r.in_mon;

      totalUsedDice += r.used_dice;
      totalUsedCb += r.used_cb;
      totalUsedMon += r.used_mon;

      totalBalDice += r.bal_dice;
      totalBalCb += r.bal_cb;
      totalBalMon += r.bal_mon;

      const row = wsCU.addRow([
        r.Organization_name,
        r.division_name,
        r.in_dice,
        r.in_cb,
        r.in_mon,
        r.used_dice,
        r.used_cb,
        r.used_mon,
        r.bal_dice,
        r.bal_cb,
        r.bal_mon,
      ]);

      row.eachCell((c) => borderThin(c));
    });

    const totalRow = wsCU.addRow([
      "Total",
      "",
      totalInDice,
      totalInCb,
      totalInMon,
      totalUsedDice,
      totalUsedCb,
      totalUsedMon,
      totalBalDice,
      totalBalCb,
      totalBalMon,
    ]);
    totalRow.font = { bold: true };
    totalRow.eachCell((c) => {
      fill(c, "C6E0B4"); // green total
      borderThin(c);
    });


    const ws = wb.addWorksheet("Account_Audit", {
      views: [{ state: "frozen", ySplit: 2 }],
    });

    const setHeaderRow = (row, bg) => {
      row.font = { bold: true };
      row.alignment = {
        horizontal: "center",
        vertical: "middle",
        wrapText: true,
      };
      row.eachCell((c) => {
        fill(c, bg);
        borderThin(c);
      });
    };

    const addTable = ({ startRow, startCol, headers, rows, headerBg }) => {
      const headerRow = ws.getRow(startRow);
      headers.forEach((h, i) => (headerRow.getCell(startCol + i).value = h));
      setHeaderRow(headerRow, headerBg);
      headerRow.height = 20;

      rows.forEach((r, idx) => {
        const row = ws.getRow(startRow + 1 + idx);
        r.forEach((val, j) => {
          const cell = row.getCell(startCol + j);
          cell.value = val;
          cell.alignment = {
            vertical: "middle",
            horizontal: "center",
            wrapText: true,
          };
          borderThin(cell);
        });
      });

      return startRow + 1 + rows.length;
    };

    ws.getColumn(1).width = 6;
    ws.getColumn(2).width = 24;
    ws.getColumn(3).width = 16;
    ws.getColumn(4).width = 28;
    ws.getColumn(5).width = 22;
    ws.getColumn(6).width = 18;
    ws.getColumn(7).width = 18;
    ws.getColumn(8).width = 30;
    ws.getColumn(9).width = 6;
    ws.getColumn(10).width = 24;
    ws.getColumn(11).width = 16;
    ws.getColumn(12).width = 28;
    ws.getColumn(13).width = 18;

    ws.mergeCells("A1:G1");
    ws.getCell("A1").value = "Tresume Account Creation";
    ws.getCell("A1").font = { bold: true, size: 12 };
    ws.getCell("A1").alignment = { horizontal: "center", vertical: "middle" };
    fill(ws.getCell("A1"), "92D050");

    ws.mergeCells("I1:M1");
    ws.getCell("I1").value = "Tresume Account Deactivation";
    ws.getCell("I1").font = { bold: true, size: 12, color: { argb: "FFFFFF" } };
    ws.getCell("I1").alignment = { horizontal: "center", vertical: "middle" };
    fill(ws.getCell("I1"), "C00000");

    addTable({
      startRow: 2,
      startCol: 1,
      headers: [
        "Sno",
        "Candidate Name",
        "Created Date",
        "UserEmail",
        "Organization",
        "Division",
        "Mail Request by",
      ],
      rows: accountCreation.map((r, i) => [
        i + 1,
        r.FullName,
        r.createdTime,
        r.email,
        r.Organization_name,
        r.division_name,
        r.RequestedBy || "",
      ]),
      headerBg: "C6E0B4",
    });

    addTable({
      startRow: 2,
      startCol: 9,
      headers: [
        "SNO",
        "Candidate Name",
        "Deactivation Date",
        "UserEmail",
        "Requestby",
      ],
      rows: accountDeactivate.map((r, i) => [
        i + 1,
        r.FullName,
        r.DeactivatedTime,
        r.email,
        r.DeactivateRequestedBy || "",
      ]),
      headerBg: "F8CBAD",
    });

    const creationSummary = (() => {
      const map = new Map();

      accountCreation.forEach((r) => {
        const company = (r.Organization_name || "").trim();
        const reqBy = (r.RequestedBy || "").trim();
        if (!company) return;

        if (!map.has(company)) {
          map.set(company, {
            CompanyName: company,
            requestedBySet: [],
            Count: 0,
          });
        }
        const obj = map.get(company);
        if (reqBy) obj.requestedBySet.push(reqBy); //  correct
        obj.Count += 1;
      });

      return Array.from(map.values())
        .sort((a, b) => a.CompanyName.localeCompare(b.CompanyName))
        .map((x, i) => ({
          Sno: i + 1,
          CompanyName: x.CompanyName,
          RequestedBy: Array.from(x.requestedBySet).join(", "),
          Count: x.Count,
        }));
    })();

    const afterTop = ws.lastRow ? ws.lastRow.number + 4 : 3;

    ws.mergeCells(`B${afterTop - 1}:E${afterTop - 1}`);
    ws.getCell(`B${afterTop - 1}`).value = "Account Creation";
    ws.getCell(`B${afterTop - 1}`).font = { bold: true };
    ws.getCell(`B${afterTop - 1}`).alignment = { horizontal: "center" };
    fill(ws.getCell(`B${afterTop - 1}`), "F8CBAD");
    borderThin(ws.getCell(`B${afterTop - 1}`));

    addTable({
      startRow: afterTop,
      startCol: 2,
      headers: [
        "Sno",
        "Company Name",
        "Mail Request by",
        "Count of Mail Request",
      ],
      rows: creationSummary.map((x) => [
        x.Sno,
        x.CompanyName,
        x.RequestedBy,
        x.Count,
      ]),
      headerBg: "F8CBAD",
    });

    const firstDataRow = afterTop + 1;
    const lastDataRow = afterTop + creationSummary.length;

    let mergeStart = firstDataRow;

    for (let r = firstDataRow; r <= lastDataRow; r++) {
      const cur = ws.getCell(`B${r}`).value || "";
      const next = r < lastDataRow ? ws.getCell(`B${r + 1}`).value || "" : null;

      if (cur !== next) {
        // merge from mergeStart -> r
        if (mergeStart < r) {
          ws.mergeCells(`B${mergeStart}:B${r}`);
          ws.getCell(`B${mergeStart}`).alignment = {
            vertical: "middle",
            horizontal: "left",
            wrapText: true,
          };
        }
        mergeStart = r + 1;
      }
    }

    ws.mergeCells(`I${afterTop - 1}:L${afterTop - 1}`);
    ws.getCell(`I${afterTop - 1}`).value = "Deactivated Accounts";
    ws.getCell(`I${afterTop - 1}`).font = { bold: true };
    ws.getCell(`I${afterTop - 1}`).alignment = { horizontal: "center" };
    fill(ws.getCell(`I${afterTop - 1}`), "F8CBAD");
    borderThin(ws.getCell(`I${afterTop - 1}`));

    addTable({
      startRow: afterTop,
      startCol: 9,
      headers: [
        "Sno",
        "Company Name",
        "Mail Request by",
        "Count of Mail Request",
      ],
      rows: deactSummary.map((x) => [
        x.Sno,
        x.CompanyName,
        x.RequestedBy,
        x.Count,
      ]),
      headerBg: "F8CBAD",
    });


    const wsOB = wb.addWorksheet("Onboarding_Report", {
      views: [{ state: "frozen", ySplit: 3 }],
    });

    const setCell = (addr, value, bold = false, size = 11) => {
      const c = wsOB.getCell(addr);
      c.value = value;
      c.font = { bold, size };
      return c;
    };

    wsOB.getColumn(1).width = 6; // SNO
    wsOB.getColumn(2).width = 22; // OrganizationName
    wsOB.getColumn(3).width = 16; // CreateDate
    wsOB.getColumn(4).width = 16; // Star
    wsOB.getColumn(5).width = 18; // FirstName
    wsOB.getColumn(6).width = 18; // LastName
    wsOB.getColumn(7).width = 18; // PercentComplete

    wsOB.mergeCells("A1:G1");
    setCell("A1", "On-Boarding Report", true, 14);
    wsOB.getCell("A1").alignment = { horizontal: "center", vertical: "middle" };

    wsOB.mergeCells("A2:G2");
    setCell("A2", "Ordered by Organization Name", true, 12);
    wsOB.getCell("A2").alignment = { horizontal: "center", vertical: "middle" };

    const headerRow = wsOB.getRow(3);
    headerRow.values = [
      "SNO",
      "OrganizationName",
      "CreateDate",
      "StartDate",
      "FirstName",
      "LastName",
      "PercentComplete",
    ];
    headerRow.font = { bold: true };
    headerRow.alignment = {
      horizontal: "center",
      vertical: "middle",
      wrapText: true,
    };
    headerRow.height = 20;

    headerRow.eachCell((cell) => {
      fill(cell, "FFF2CC");
      borderThin(cell);
    });

    const onboardSorted = [...accountOnboard].sort((a, b) => {
      const oa = (a.Organization_name || "").toLowerCase();
      const ob = (b.Organization_name || "").toLowerCase();
      if (oa !== ob) return oa.localeCompare(ob);
      return new Date(a.CreatedDate) - new Date(b.CreatedDate);
    });

    let rowIndex = 4;
    onboardSorted.forEach((r, i) => {
      const row = wsOB.getRow(rowIndex++);
      row.values = [
        i + 1,
        r.Organization_name || "",
        r.CreatedDate || "",
        r.OnboardDate || "",
        r.FirstName || "",
        r.LastName || "",
        r.PercentComplete ?? 0,
      ];
      row.alignment = {
        horizontal: "left",
        vertical: "middle",
        wrapText: true,
      };
      row.eachCell((cell) => borderThin(cell));
    });

    rowIndex += 3;

    wsOB.getRow(rowIndex).values = [
      "S.NO",
      "OrganizationName",
      "Candidate Count",
    ];
    wsOB.getRow(rowIndex).font = { bold: true };
    wsOB.getRow(rowIndex).alignment = {
      horizontal: "left",
      vertical: "middle",
      wrapText: true,
    };
    wsOB.getRow(rowIndex).eachCell((cell) => {
      fill(cell, "E2F0D9");
      borderThin(cell);
    });
    rowIndex++;


    const orgCountMap = new Map();
    onboardSorted.forEach((r) => {
      const org = (r.Organization_name || "").trim();
      if (!org) return;
      orgCountMap.set(org, (orgCountMap.get(org) || 0) + 1);
    });

    let grandTotal = 0;
    let sno2 = 1;
    Array.from(orgCountMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .forEach(([org, count]) => {
        const row = wsOB.getRow(rowIndex++);
        row.values = [sno2, org, count];
        row.eachCell((cell) => borderThin(cell));
        grandTotal += count;
        sno2++;
      });


    const gtRow = wsOB.getRow(rowIndex);
    gtRow.values = ["", "Grand Total", grandTotal];
    gtRow.font = { bold: true };
    gtRow.eachCell((cell) => {
      fill(cell, "C6E0B4");
      borderThin(cell);
    });

    const dateObj = new Date(start);

    const monthName = dateObj.toLocaleString('en-US', { month: 'long' });
    const year = dateObj.getFullYear();

    const filename = `Internalreport_${monthName}_${year}.xlsx`;


    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    );

    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error("export error:", e);
    res.status(500).json({ message: "Export failed" });
  }
});

router.post("/delete/users", async (req, res) => {
  const { divisionId, candidateId, orgId, reason, createdAt, mailAttachment } =
    req.body;

  try {
    const pool = await sql.connect(config);

    const result = await pool
      .request()
      .input("divisionId", sql.Int, divisionId)
      .input("candidateId", sql.Int, candidateId)
      .input("orgId", sql.Int, orgId)
      .input("reason", sql.NVarChar(4000), reason || "")
      .input("createdAt", sql.DateTime, createdAt)
      .input("mailAttachment", sql.NVarChar(sql.MAX), mailAttachment || null)
      .query(`
        UPDATE Users
        SET Active = 0,
            DeactivateRequestedBy = @reason,
            MailAttachment = @mailAttachment,
            DeactivatedTime = @createdAt
        WHERE org_div = @divisionId
          AND userId = @candidateId
          AND OrgId = @orgId;
      `);

    return res.json({ success: true, rowsAffected: result.rowsAffected });
  } catch (error) {
    console.error("Error deleting user:", error);
    return res.status(500).json({ message: "Failed to delete user" });
  }
});

router.get("/users/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) return res.status(400).json({ message: "userId required" });

    const pool = await sql.connect(config);

    const result = await pool.request().input("userId", sql.Int, Number(userId))
      .query(`
        SELECT TOP 1
          userId,
          firstName,
          lastName,
          email,
          AccessType,
          OrgId,
          org_div,
          noOfAdmins,
          noOfRecruiters,
          UserNavAccess,
          ai_access,
          UpdateRequestBy
        FROM Users
        WHERE userId = @userId
      `);

    if (!result.recordset?.length) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.json(result.recordset[0]);
  } catch (e) {
    console.error("getUserById error:", e);
    return res.status(500).json({ message: "Failed to fetch user" });
  }
});

router.put("/users/update-full", async (req, res) => {
  try {
    const {
      userId,
      firstName,
      lastName,
      email,
      RequestedBy,
      AccessType,
      OrgId,
      org_div,
      noOfAdmins,
      noOfRecruiters,
      UserNavAccess,
      ai_access,
    } = req.body;

    if (!userId) return res.status(400).json({ message: "userId required" });
    if (!email) return res.status(400).json({ message: "email required" });
    if (!RequestedBy || !String(RequestedBy).trim()) {
      return res.status(400).json({ message: "RequestedBy required" });
    }

    const isValidJson = (s) => {
      if (s === null || s === undefined) return true;
      if (typeof s !== "string") return false;
      const t = s.trim();
      if (!t) return true;
      try {
        JSON.parse(t);
        return true;
      } catch {
        return false;
      }
    };

    if (!isValidJson(UserNavAccess)) {
      return res.status(400).json({ message: "UserNavAccess JSON invalid" });
    }
    if (!isValidJson(ai_access)) {
      return res.status(400).json({ message: "ai_access JSON invalid" });
    }

    const pool = await sql.connect(config);

    // email duplicate check (exclude same userId)
    const dup = await pool
      .request()
      .input("email", sql.VarChar, email)
      .input("userId", sql.Int, Number(userId)).query(`
        SELECT TOP 1 userId
        FROM Users
        WHERE email = @email AND userId <> @userId
      `);

    if (dup.recordset?.length) {
      return res.status(409).json({ message: "Email already exists" });
    }

    //  Update
    await pool
      .request()
      .input("userId", sql.Int, Number(userId))
      .input("firstName", sql.VarChar, firstName ?? "")
      .input("lastName", sql.VarChar, lastName ?? "")
      .input("email", sql.VarChar, email)
      .input("RequestedBy", sql.VarChar, RequestedBy)

      .input(
        "AccessType",
        sql.Int,
        AccessType != null ? Number(AccessType) : null
      )
      .input("OrgId", sql.Int, OrgId != null ? Number(OrgId) : null)
      .input("org_div", sql.Int, org_div != null ? Number(org_div) : null)

      .input("noOfAdmins", sql.Int, noOfAdmins != null ? Number(noOfAdmins) : 0)
      .input(
        "noOfRecruiters",
        sql.Int,
        noOfRecruiters != null ? Number(noOfRecruiters) : 0
      )

      .input("UserNavAccess", sql.NVarChar(sql.MAX), UserNavAccess ?? "")
      .input("ai_access", sql.NVarChar(sql.MAX), ai_access ?? "").query(`
        UPDATE Users
        SET
          firstName = @firstName,
          lastName = @lastName,
          email = @email,
          UpdateRequestBy = @RequestedBy,

          AccessType = ISNULL(@AccessType, AccessType),
          OrgId = ISNULL(@OrgId, OrgId),
          org_div = ISNULL(@org_div, org_div),

          noOfAdmins = @noOfAdmins,
          noOfRecruiters = @noOfRecruiters,

          UserNavAccess = @UserNavAccess,
          ai_access = @ai_access
        WHERE userId = @userId
      `);

    return res.json({ message: "User updated successfully" });
  } catch (e) {
    console.error("updateUserFull error:", e);
    return res.status(500).json({ message: "Update failed" });
  }
});
router.get("/activity/today", async (req, res) => {
  const userId = req.query.userId;
  const today = new Date().toISOString().split("T")[0];

  if (!userId)
    return res.status(401).json({ message: "User not authenticated" });

  try {
    const pool = await sql.connect(config);
    const result = await pool
      .request()
      .input("userId", sql.Int, userId)
      .input("logDate", sql.Date, today)
      .query(
        `SELECT loginlogout FROM user_login_activity WHERE userId=@userId`
      );

    if (!result.recordset.length || !result.recordset[0].loginlogout)
      return res.json({});

    let data = [];
    try {
      data = JSON.parse(result.recordset[0].loginlogout);
    } catch {
      data = [];
    }

    const todayData = data.find((d) => d.date === today);
    if (!todayData) return res.json({});

    const sessions = todayData.sessions.map((s) => ({
      login: s.login,
      logout: s.logout,
      isActive: s.isActive,
      duration: s.logout ? calcDuration(s.login, s.logout) : "--",
    }));

    res.json({
      firstLogin: todayData.sessions[0]?.login || null,
      lastLogout: todayData.sessions.slice(-1)[0]?.logout || null,
      totalHours: calculateTotal(todayData.sessions),
      isActive: todayData.sessions.some((s) => s.isActive),
      sessions,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error fetching activity" });
  }
});

// ------------------
// HELPERS
// ------------------
function parseTime(timeStr) {
  if (!timeStr) return null;
  const [time, modifier] = timeStr.split(" ");
  let [hours, minutes] = time.split(":").map(Number);
  if (modifier === "PM" && hours < 12) hours += 12;
  if (modifier === "AM" && hours === 12) hours = 0;
  return hours * 60 + minutes;
}

function calcDuration(login, logout) {
  let start = parseTime(login);
  let end = parseTime(logout);
  if (start === null || end === null) return "--";
  if (end < start) end += 1440;
  const diff = end - start;
  return `${Math.floor(diff / 60)}h ${diff % 60}m`;
}

function calculateTotal(sessions) {
  let total = 0;
  sessions.forEach((s) => {
    if (s.login && s.logout) {
      let start = parseTime(s.login);
      let end = parseTime(s.logout);
      if (end < start) end += 1440;
      total += end - start;
    }
  });
  return `${Math.floor(total / 60)}h ${total % 60}m`;
}

router.get("/recruiter-stats", async (req, res) => {
  try {
    const pool = await sql.connect(config);

    const accessType = Number(req.query.accessType);
    const orgid = req.query.orgid;
    const orgdiv = req.query.divisionId;

    if (![1, 2].includes(accessType)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid access type" });
    }

    let query = "";
    let params = [];

    switch (accessType) {
      case 1:
        query = `
          SELECT * FROM org_div
          WHERE active = 1 AND orgId = @orgid
        `;
        params = [{ name: "orgid", type: sql.Int, value: orgid }];
        break;

      case 2:
        query = `
          SELECT * FROM org_div
          WHERE active = 1 AND orgId = @orgid AND id = @orgdiv
        `;
        params = [
          { name: "orgid", type: sql.Int, value: orgid },
          { name: "orgdiv", type: sql.Int, value: orgdiv },
        ];
        break;
    }

    const request = pool.request();
    params.forEach((p) => request.input(p.name, p.type, p.value));

    const result = await request.query(query);

    res.status(200).json({ success: true, data: result.recordset });
  } catch (error) {
    console.error("Recruiter stats error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/recruiter-stats-new", async (req, res) => {
  try {
    const pool = await sql.connect(config);

    const orgdiv = req.query.divisionId
      ? parseInt(req.query.divisionId)
      : null;

    const userId = req.query.userid
      ? parseInt(req.query.userid)
      : null;

    const result = await pool
      .request()
      .input("orgdiv", sql.Int, orgdiv)
      .input("userId", sql.Int, userId)
      .query(`
        SELECT
          U.userId,
          CONCAT(U.firstName, ' ', U.lastName) AS FullName,
          U.Org_Div,
          O.division_name,
          L.loginlogout,
          L.logDate,
          L.createdAt
        FROM users AS U
        INNER JOIN org_div AS O
          ON U.Org_Div = O.id
        LEFT JOIN user_login_activity AS L
          ON L.userId = U.userId
         AND L.Org_Div = U.Org_Div
        WHERE (@orgdiv IS NULL OR U.Org_Div = @orgdiv)
          AND U.active = 1
        ORDER BY U.firstName;
      `);

    res.status(200).json({ success: true, data: result.recordset });
  } catch (error) {
    console.error("Recruiter stats new error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/recruiter-History", async (req, res) => {
  try {
    const pool = await sql.connect(config);

    // const orgdiv = req.query.divisionId;
    const userId = req.query.userId;

    const result = await pool
      .request()
      // .input("orgdiv", sql.Int, orgdiv)
      .input("userId", sql.Int, userId)
      .query(`
  select * from  user_login_activity where userId = @userId 
      `);

    res.status(200).json({ success: true, data: result.recordset });

  } catch (error) {
    console.error("Recruiter stats new error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/getrecruiter/:divisionId", async (req, res) => {
  try {
    const pool = await sql.connect(config);

    const divisionId = req.params.divisionId;


    const result = await pool
      .request()
      .input("divisionId", sql.Int, divisionId)
      .query(`
        SELECT *
        FROM users
        WHERE org_div = @divisionId
      `);

    res.status(200).json({
      success: true,
      data: result.recordset
    });

  } catch (error) {
    console.error("Recruiter error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/getcandidate/:userId", async (req, res) => {
  try {
    const pool = await sql.connect(config);
    const userId = req.params.userId;
    const result = await pool
      .request()
      .input("userId", sql.Int, userId)
      .query(`
      select * from candidate where createdby = @userId AND Active = 1
      `);

    res.status(200).json({
      success: true,
      data: result.recordset
    });
  } catch (error) {
    console.error("candidate error:", error);
    res.status(500).json({ success: true, message: error.message });
  }
})



const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const { orgId, org_div } = req.body;
    const dir = path.join(
      __dirname,
      "..",
      "tresume3-0",
      "Overall_Document",
      "candidate_change_doc",
      `organization_${orgId}`,
      `division_${org_div}`,
    );
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + "-" + file.originalname;
    cb(null, uniqueName);
  }
});


const upload = multer({ storage });



router.post("/getcandidatechange", upload.single("file"), async (req, res) => {
  let pool;
  try {
    pool = await sql.connect(config);

    const {
      userId,
      candidateIds,
      requestBy,
      orgId,
      org_div,
      recruiterId
    } = req.body;

    //  Validation
    if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "candidateIds must be a non-empty array"
      });
    }

    for (const candidateId of candidateIds) {
      await pool.request()
        .input("candidateId", sql.Int, candidateId)
        .input("userId", sql.Int, userId)
        .query(`
          UPDATE candidate
          SET createdby = @userId
          WHERE candidate_id = @candidateId
        `);
    }

    // const candidateCsv = candidateIds.join(",");

    const filePath = await uploadToCandidateBlob(req.file, orgId, org_div);

    console.log("File uploaded to blob storage at:", filePath);

    const existingRow = await pool.request()
      .input("userId", sql.Int, userId)
      .query(`
        SELECT id, request_by
        FROM candidate_assign_recruiter
        WHERE user_id = @userId
      `);

    let jsonArray = [];
    let rowId = null;

    if (existingRow.recordset.length > 0) {
      rowId = existingRow.recordset[0].id;

      if (existingRow.recordset[0].request_by) {
        try {
          jsonArray = JSON.parse(existingRow.recordset[0].request_by);
        } catch {
          jsonArray = [];
        }
      }
    }

    const nextJsonId =
      jsonArray.length > 0
        ? Math.max(...jsonArray.map(j => j.id || 0)) + 1
        : 1;

    const newJson = {
      id: nextJsonId,
      From: recruiterId,
      candidateIds,
      requestedBy: requestBy,
      createdAt: new Date(),
      attachment: filePath ?? null
    };

    jsonArray.push(newJson);


    if (rowId) {
      await pool.request()
        .input("id", sql.Int, rowId)
        .input("userId", sql.Int, userId)
        // .input("candidateIds", sql.NVarChar, candidateCsv)
        .input("json", sql.NVarChar, JSON.stringify(jsonArray))
        .query(`
          UPDATE candidate_assign_recruiter
          SET
          request_by = @json
          WHERE id = @id AND user_id = @userId
        `);
    }

    else {
      await pool.request()
        .input("userId", sql.Int, userId)
        .input("orgId", sql.Int, orgId)
        .input("orgDiv", sql.Int, org_div)
        // .input("candidateIds", sql.NVarChar, candidateCsv)
        .input("json", sql.NVarChar, JSON.stringify(jsonArray))
        .query(`
          INSERT INTO candidate_assign_recruiter
          (user_id, org_id, org_div, request_by)
          VALUES
          (@userId, @orgId, @orgDiv, @json)
        `);
    }

    res.status(200).json({
      success: true,
      message: "Candidate reassignment completed",
      data: jsonArray
    });

  } catch (err) {
    console.error("Candidate change error:", err);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

router.get("/getcandidatechangereport", async (req, res) => {
  try {
    const pool = await sql.connect(config);
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;

    const result = await pool.request()
      .query(`
        
SELECT 
    ct.id AS Transfer_Id,

    -- Recruiter Name
    u1.firstName AS Recruiter_Name,

    -- From Name
    u2.firstName AS From_Name,

    JSON_VALUE(r.value, '$.requestedBy') AS Requested_By,

    JSON_VALUE(r.value, '$.attachment') AS Attachment,

    JSON_VALUE(r.value, '$.createdAt') AS Created_Date,

    -- Candidate Details
    c.value AS Candidate_Id,
    ca.firstName AS Candidate_Name,

    -- Organization Details
    org.Organization_name AS Organization_Name,
    div.Division_name AS Division_Name

FROM candidate_assign_recruiter ct

-- Recruiter Join
LEFT JOIN users u1 
ON ct.user_id = u1.userId

-- JSON Split
CROSS APPLY OPENJSON(ct.request_by) r

-- From User Join
LEFT JOIN users u2 
ON JSON_VALUE(r.value,'$.From') = u2.userId

-- Candidate Split
CROSS APPLY OPENJSON(JSON_QUERY(r.value,'$.candidateIds')) c

-- Candidate Join
LEFT JOIN candidate ca 
ON ca.candidate_id = c.value

-- Organization Join
LEFT JOIN organization org 
ON ct.org_id = org.id

-- Division Join
LEFT JOIN org_div div 
ON ct.org_div = div.id

WHERE 
ISJSON(ct.request_by) = 1
AND CAST(JSON_VALUE(r.value,'$.createdAt') AS DATETIME)
BETWEEN '${startDate}' AND '${endDate}'

ORDER BY Created_Date DESC;

      `);

    res.status(200).json({
      success: true,
      data: result.recordset
    })
  } catch (error) {
    console.error("Candidate change report error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});



router.get("/:orgId/credits", async (req, res) => {
  const { orgId } = req.params;

  try {
    const pool = await sql.connect(config);

    //  1. ORG LEVEL CREDITS
    const orgResult = await pool.request()
      .input("orgId", sql.Int, orgId)
      .query(`
        SELECT 
          dice, careerbuilder, monster,
          used_dice, used_careerbuilder, used_monster,
          bal_dice, bal_careerbuilder, bal_monster
        FROM org_credits
        WHERE org_id = @orgId
      `);

    const orgRow = orgResult.recordset[0] || {};

    //  2. USER LEVEL ALLOCATION
    const userResult = await pool.request()
      .input("orgId", sql.Int, orgId)
      .query(`
   SELECT 
  u.userId AS holder_id,
  ISNULL(w.holder_type, u.AccessType) AS holder_type,

  u.userId,
  ISNULL(u.firstName, '') + ' ' + ISNULL(u.lastName, '') AS name,
  u.email,
  u.org_div,
 CASE 
    WHEN w.holder_id IS NULL THEN 0
    ELSE 1
  END AS isAllocated,
  -- Dice
  ISNULL(w.in_dice, 0) AS in_dice,
  ISNULL(w.used_dice, 0) AS used_dice,
  ISNULL(w.bal_dice, 0) AS bal_dice,

  -- CB
  ISNULL(w.in_cb, 0) AS in_cb,
  ISNULL(w.used_cb, 0) AS used_cb,
  ISNULL(w.bal_cb, 0) AS bal_cb,

  -- Monster
  ISNULL(w.in_mon, 0) AS in_mon,
  ISNULL(w.used_mon, 0) AS used_mon,
  ISNULL(w.bal_mon, 0) AS bal_mon

FROM Users u
LEFT JOIN credit_wallet w 
  ON u.userId = w.holder_id 
  AND w.org_id = @orgId

WHERE u.OrgId = @orgId   --  IMPORTANT
AND u.Active = 1         -- optional filter
  `);

    res.json({
      summary: {
        totalDice: orgRow.dice || 0,
        usedDice: orgRow.used_dice || 0,
        remainingDice: orgRow.bal_dice || 0,

        totalCareerBuilder: orgRow.careerbuilder || 0,
        usedCareerBuilder: orgRow.used_careerbuilder || 0,
        remainingCareerBuilder: orgRow.bal_careerbuilder || 0,

        totalMonster: orgRow.monster || 0,
        usedMonster: orgRow.used_monster || 0,
        remainingMonster: orgRow.bal_monster || 0
      },

      allocations: userResult.recordset || []
    });

  } catch (err) {
    logger.error("org credits error", { message: err.message });
    res.status(500).json({ message: "Server Error" });
  }
});

router.post('/credits/manage', async (req, res) => {

  const db = req.app.locals.db || await sql.connect(config);
  const tx = new sql.Transaction(db);

  try {

    const {
      org_id,
      orgdiv_id = null,
      holder_id,
      holder_type,
      dice = 0,
      careerbuilder = 0,
      monster = 0,
      action,
      created_by,
      note = null
    } = req.body || {};

    const d = Number(dice || 0);
    const cb = Number(careerbuilder || 0);
    const m = Number(monster || 0);

    // =========================================================
    // VALIDATION
    // =========================================================

    if (
      !org_id ||
      !holder_id ||
      !holder_type ||
      !created_by ||
      !action
    ) {
      return res.status(400).json({
        ok: false,
        error: 'MISSING_FIELDS'
      });
    }

    if (d < 0 || cb < 0 || m < 0) {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_CREDIT_VALUES'
      });
    }

    if ((d | 0) === 0 && (cb | 0) === 0 && (m | 0) === 0) {
      return res.status(400).json({
        ok: false,
        error: 'ZERO_CREDITS'
      });
    }

    await tx.begin();


    if (action === 'ADD') {


      const balCheck = await new sql.Request(tx)
        .input('org_id', sql.Int, org_id)
        .query(`
          SELECT TOP 1
            bal_dice,
            bal_careerbuilder,
            bal_monster
          FROM org_credits 
          WHERE org_id = @org_id
        `);

      const bal = balCheck.recordset?.[0] || {};

      const availDice = Number(bal.bal_dice || 0);
      const availCb = Number(bal.bal_careerbuilder || 0);
      const availMon = Number(bal.bal_monster || 0);

      if (
        d > availDice ||
        cb > availCb ||
        m > availMon
      ) {

        await tx.rollback();

        return res.status(409).json({
          ok: false,
          error: 'INSUFFICIENT_ORG_CREDITS',
          avail: {
            dice: availDice,
            careerbuilder: availCb,
            monster: availMon
          }
        });
      }



      await new sql.Request(tx)
        .input('org_id', sql.Int, org_id)
        .input('orgdiv_id', sql.Int, orgdiv_id)
        .input('holder_type', sql.TinyInt, holder_type)
        .input('holder_id', sql.Int, holder_id)
        .input('d', sql.Int, d)
        .input('cb', sql.Int, cb)
        .input('m', sql.Int, m)
        .query(`
          MERGE credit_wallet AS T
          USING (
            SELECT
              @org_id org_id,
              @orgdiv_id orgdiv_id,
              @holder_type holder_type,
              @holder_id holder_id
          ) AS S
          ON (
            T.org_id = S.org_id
            AND ISNULL(T.orgdiv_id,-1)=ISNULL(S.orgdiv_id,-1)
            AND T.holder_type = S.holder_type
            AND T.holder_id = S.holder_id
          )

          WHEN MATCHED THEN
            UPDATE SET
              in_dice = ISNULL(in_dice,0) + @d,
              in_cb = ISNULL(in_cb,0) + @cb,
              in_mon = ISNULL(in_mon,0) + @m

          WHEN NOT MATCHED THEN
            INSERT (
              org_id,
              orgdiv_id,
              holder_type,
              holder_id,
              in_dice,
              in_cb,
              in_mon
            )
            VALUES (
              S.org_id,
              S.orgdiv_id,
              S.holder_type,
              S.holder_id,
              @d,
              @cb,
              @m
            );
        `);



      const upd = await new sql.Request(tx)
        .input('org_id', sql.Int, org_id)
        .input('d', sql.Int, d)
        .input('cb', sql.Int, cb)
        .input('m', sql.Int, m)
        .query(`
          UPDATE org_credits
          SET
            used_dice = ISNULL(used_dice,0) + @d,
            used_careerbuilder = ISNULL(used_careerbuilder,0) + @cb,
            used_monster = ISNULL(used_monster,0) + @m

          WHERE org_id = @org_id

          AND (ISNULL(used_dice,0) + @d)
              <= ISNULL(dice,0)

          AND (ISNULL(used_careerbuilder,0) + @cb)
              <= ISNULL(careerbuilder,0)

          AND (ISNULL(used_monster,0) + @m)
              <= ISNULL(monster,0)
        `);

      if (upd.rowsAffected?.[0] !== 1) {

        await tx.rollback();

        return res.status(409).json({
          ok: false,
          error: 'CONCURRENT_OR_EXCEEDS_POOL'
        });
      }
    }


    if (action === 'REVOKE') {

      const wallet = await new sql.Request(tx)
        .input('org_id', sql.Int, org_id)
        .input('holder_id', sql.Int, holder_id)
        .input('holder_type', sql.TinyInt, holder_type)
        .query(`
          SELECT TOP 1
            in_dice,
            in_cb,
            in_mon,
            used_dice,
            used_cb,
            used_mon
          FROM credit_wallet WITH (ROWLOCK, UPDLOCK)

          WHERE org_id = @org_id
          AND holder_id = @holder_id
          AND holder_type = @holder_type
        `);

      const w = wallet.recordset?.[0];

      if (!w) {

        await tx.rollback();

        return res.status(404).json({
          ok: false,
          error: 'WALLET_NOT_FOUND'
        });
      }

      const balDice =
        Number(w.in_dice || 0) -
        Number(w.used_dice || 0);

      const balCb =
        Number(w.in_cb || 0) -
        Number(w.used_cb || 0);

      const balMon =
        Number(w.in_mon || 0) -
        Number(w.used_mon || 0);

      if (
        d > balDice ||
        cb > balCb ||
        m > balMon
      ) {

        await tx.rollback();

        return res.status(409).json({
          ok: false,
          error: 'INSUFFICIENT_USER_BALANCE',
          avail: {
            dice: balDice,
            careerbuilder: balCb,
            monster: balMon
          }
        });
      }



      await new sql.Request(tx)
        .input('org_id', sql.Int, org_id)
        .input('holder_id', sql.Int, holder_id)
        .input('holder_type', sql.TinyInt, holder_type)
        .input('d', sql.Int, d)
        .input('cb', sql.Int, cb)
        .input('m', sql.Int, m)
        .query(`
          UPDATE credit_wallet
          SET
            in_dice = ISNULL(in_dice,0) - @d,
            in_cb = ISNULL(in_cb,0) - @cb,
            in_mon = ISNULL(in_mon,0) - @m

          WHERE org_id = @org_id
          AND holder_id = @holder_id
          AND holder_type = @holder_type
        `);



      await new sql.Request(tx)
        .input('org_id', sql.Int, org_id)
        .input('d', sql.Int, d)
        .input('cb', sql.Int, cb)
        .input('m', sql.Int, m)
        .query(`
          UPDATE org_credits
          SET
            used_dice = ISNULL(used_dice,0) - @d,
            used_careerbuilder = ISNULL(used_careerbuilder,0) - @cb,
            used_monster = ISNULL(used_monster,0) - @m

          WHERE org_id = @org_id
        `);
    }


    const ledger = await new sql.Request(tx)
      .input('org_id', sql.Int, org_id)
      .input('orgdiv_id', sql.Int, orgdiv_id)
      .input('to_type', sql.TinyInt, holder_type)
      .input('to_id', sql.Int, holder_id)
      .input('d', sql.Int, d)
      .input('cb', sql.Int, cb)
      .input('m', sql.Int, m)
      .input('created_by', sql.Int, created_by)
      .input('note', sql.NVarChar(200), note || action)
      .query(`
        INSERT INTO credit_ledger
        (
          org_id,
          orgdiv_id,
          from_type,
          from_id,
          to_type,
          to_id,
          dice,
          careerbuilder,
          monster,
          created_by,
          note
        )
        VALUES
        (
          @org_id,
          @orgdiv_id,
          1,
          NULL,
          @to_type,
          @to_id,
          @d,
          @cb,
          @m,
          @created_by,
          @note
        );

        SELECT SCOPE_IDENTITY() AS id;
      `);

    await tx.commit();

    return res.json({
      ok: true,
      ledgerId: Number(ledger.recordset?.[0]?.id || 0),
      message:
        action === 'ADD'
          ? 'Credits allocated successfully'
          : 'Credits revoked successfully'
    });

  } catch (err) {

    try {
      await tx.rollback();
    } catch { }

    console.error('/credits/manage', err);

    return res.status(500).json({
      ok: false,
      error: err.message || 'SERVER_ERROR'
    });
  }
});

router.get("/check-email/:email", async (req, res) => {
  const { email } = req.params;

  try {
    const pool = await sql.connect(config);

    const result = await pool.request()
      .input('email', sql.VarChar, email)
      .query(`
        SELECT COUNT(*) as emailCount
        FROM Users
        WHERE email = @email
      `);

    res.json({ exists: result.recordset[0].emailCount > 0 });

  } catch (err) {
    console.error("CHECK EMAIL ERROR:", err);
    res.status(500).json({
      message: err.message
    });
  }
});
module.exports = router;
