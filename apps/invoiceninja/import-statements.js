#!/usr/bin/env node

const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const AdmZip = require('adm-zip');

const DEFAULT_OUTPUT_DIR = path.join('data', 'statements', 'pdf');
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.cache', '.idea', '.vscode']);
const IBAN_MIN_LENGTH = 14;
const VALUE_LINE_REGEX = /^(\d{2})-(\d{2})(?:-(\d{4}))?\s+([\d.,]+)\s*([+-])$/;
const ISO_DATE_REGEX = /^(\d{2})-(\d{2})-(\d{4})$/;
const BIC_REGEX = /^([A-Z]{4}[A-Z0-9]{2}[A-Z0-9]{2,3})$/;

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const inputStats = await safeStat(options.inputPath);
    if (!inputStats) {
      throw new Error(`Input path not found: ${options.inputPath}`);
    }

    const collections = await collectSources(options.inputPath, inputStats, options.includeStandalonePdfs);
    if (!collections.zipFiles.length && !collections.pdfFiles.length) {
      console.log('No ZIP archives or PDF files found, nothing to import.');
      return;
    }

    await fsPromises.mkdir(options.outputDir, { recursive: true });

    const processedStatements = [];
    const failures = [];

    for (const zipPath of collections.zipFiles) {
      const zipResults = await processZipArchive(zipPath, options);
      processedStatements.push(...zipResults.statements);
      failures.push(...zipResults.failures);
    }

    for (const pdfPath of collections.pdfFiles) {
      const pdfResults = await processSinglePdf(pdfPath, options);
      processedStatements.push(...pdfResults.statements);
      failures.push(...pdfResults.failures);
    }

    if (processedStatements.length) {
      await emitAggregatedIndex(processedStatements, options.outputDir);
    }

    reportSummary(processedStatements, failures);
    if (failures.length) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`Failed to import statements: ${error.message}`);
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const options = {
    inputPath: '.',
    outputDir: DEFAULT_OUTPUT_DIR,
    includeStandalonePdfs: true,
    overwrite: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' || arg === '--source') {
      options.inputPath = argv[i + 1] || options.inputPath;
      i += 1;
    } else if (arg === '--output') {
      options.outputDir = argv[i + 1] || options.outputDir;
      i += 1;
    } else if (arg === '--no-standalone-pdf') {
      options.includeStandalonePdfs = false;
    } else if (arg === '--overwrite') {
      options.overwrite = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  return options;
}

function printUsage() {
  console.log(`Usage: node apps/invoiceninja/import-statements.js [--input <path>] [--output <path>] [--overwrite]

Options:
  --input, --source        Directory or file to scan. Defaults to current directory.
  --output                 Target directory for generated JSON files. Defaults to ${DEFAULT_OUTPUT_DIR}.
  --no-standalone-pdf      Skip PDF files that are not inside ZIP archives.
  --overwrite              Overwrite existing JSON files if they already exist.
  -h, --help               Display this help message.
`);
}

async function safeStat(targetPath) {
  try {
    return await fsPromises.stat(targetPath);
  } catch {
    return null;
  }
}

async function collectSources(rootPath, stat, includeStandalonePdfs) {
  if (stat.isFile()) {
    if (rootPath.toLowerCase().endsWith('.zip')) {
      return { zipFiles: [rootPath], pdfFiles: [] };
    }
    if (includeStandalonePdfs && rootPath.toLowerCase().endsWith('.pdf')) {
      return { zipFiles: [], pdfFiles: [rootPath] };
    }
    return { zipFiles: [], pdfFiles: [] };
  }

  const zipFiles = [];
  const pdfFiles = [];

  async function walk(directory) {
    const entries = await fsPromises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        if (entry.name.toLowerCase().endsWith('.zip')) {
          zipFiles.push(absolute);
        } else if (includeStandalonePdfs && entry.name.toLowerCase().endsWith('.pdf')) {
          pdfFiles.push(absolute);
        }
      }
    }
  }

  await walk(rootPath);
  return { zipFiles, pdfFiles };
}

async function processZipArchive(zipPath, options) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const statements = [];
  const failures = [];

  for (const entry of entries) {
    if (entry.isDirectory) {
      continue;
    }
    if (!entry.entryName.toLowerCase().endsWith('.pdf')) {
      continue;
    }
    try {
      const pdfBuffer = entry.getData();
      const parsed = await parseStatement(pdfBuffer, {
        source: 'zip',
        originPath: zipPath,
        entryName: entry.entryName,
      });
      const outputPath = await writeStatementJson(parsed, options.outputDir, options.overwrite);
      statements.push({
        ...parsed,
        outputPath,
      });
    } catch (error) {
      failures.push({
        source: 'zip',
        zipPath,
        entryName: entry.entryName,
        error: error.message,
      });
    }
  }

  return { statements, failures };
}

async function processSinglePdf(pdfPath, options) {
  const statements = [];
  const failures = [];
  try {
    const pdfBuffer = await fsPromises.readFile(pdfPath);
    const parsed = await parseStatement(pdfBuffer, {
      source: 'pdf',
      originPath: pdfPath,
    });
    const outputPath = await writeStatementJson(parsed, options.outputDir, options.overwrite);
    statements.push({
      ...parsed,
      outputPath,
    });
  } catch (error) {
    failures.push({
      source: 'pdf',
      pdfPath,
      error: error.message,
    });
  }
  return { statements, failures };
}

async function parseStatement(buffer, context) {
  const parser = new PDFParse({ data: buffer });
  try {
    const textResult = await parser.getText();
    const originalLines = textResult.text.split(/\r?\n/);
    const trimmedLines = originalLines.map((line) => line.trim()).filter((line) => Boolean(line));

    const statementMeta = extractStatementMeta(trimmedLines);
    const operations = extractOperations(trimmedLines, statementMeta, context);

    return {
      statementId: buildStatementId(statementMeta, context),
      generatedAt: new Date().toISOString(),
      source: {
        type: context.source,
        originPath: context.originPath,
        entryName: context.entryName || null,
      },
      account: statementMeta.account,
      balances: statementMeta.balances,
      statementNumber: statementMeta.statementNumber,
      statementYear: statementMeta.statementYear,
      operations,
      rawStatementLines: originalLines.map((line) => line.trimEnd()),
    };
  } finally {
    await parser.destroy();
  }
}

function extractStatementMeta(lines) {
  const ibanIndex = lines.findIndex((line) => isPotentialIbanLine(line));
  if (ibanIndex === -1) {
    throw new Error('Unable to locate account IBAN line in statement.');
  }
  const accountLine = lines[ibanIndex];
  const accountName = lines[ibanIndex - 1] || null;
  const bicLine = lines.find((line) => line.startsWith('BIC '));
  const statementTitleLine = lines.find((line) => line.includes('Extrait N°'));
  const closingBalanceLine = lines.find((line) => line.startsWith('Solde actuel au '));
  const openingBalanceLine = lines.find((line) => line.startsWith('Solde précédent au '));

  const account = {
    name: accountName,
    ...parseAccountLine(accountLine),
    bic: bicLine ? bicLine.replace('BIC', '').trim() : null,
  };

  const { statementNumber, statementYear } = parseStatementTitle(statementTitleLine);
  const balances = {
    closing: parseBalanceLine(closingBalanceLine),
    opening: parseBalanceLine(openingBalanceLine),
  };

  return {
    account,
    statementNumber,
    statementYear,
    balances,
    operationsHeaderIndex: lines.findIndex((line) => line.startsWith('N° Type d\'opération')),
  };
}

function extractOperations(lines, statementMeta, context) {
  const headerIndex = statementMeta.operationsHeaderIndex;
  if (headerIndex === -1) {
    throw new Error('Unable to find the operations header in the statement.');
  }

  let index = headerIndex + 1;
  while (lines[index] === 'Date' || lines[index]?.startsWith('Valeur Montant')) {
    index += 1;
  }

  const operations = [];
  let currentBookingDate = null;

  while (index < lines.length) {
    const line = lines[index];
    if (!line) {
      index += 1;
      continue;
    }

    if (line.startsWith('Solde ') || line.startsWith('Les dépôts ') || line.startsWith('-- ')) {
      break;
    }

    if (line.startsWith('...')) {
      index += 1;
      continue;
    }

    const dateMatch = line.match(ISO_DATE_REGEX);
    if (dateMatch) {
      currentBookingDate = toIsoDate(line);
      index += 1;
      continue;
    }

    const operationMatch = line.match(/^(0\d{3})\s+(.+)$/);
    if (!operationMatch) {
      index += 1;
      continue;
    }

    const sequence = operationMatch[1];
    const title = operationMatch[2];
    index += 1;

    const detailLines = [];
    let valueLine = null;

    while (index < lines.length) {
      const detailLine = lines[index];

      if (!detailLine) {
        index += 1;
        continue;
      }

      if (detailLine.startsWith('Solde ') || detailLine.startsWith('-- ')) {
        break;
      }

      if (detailLine.startsWith('...')) {
        index += 1;
        continue;
      }

      const bookingDateMatch = detailLine.match(ISO_DATE_REGEX);
      if (bookingDateMatch) {
        currentBookingDate = toIsoDate(detailLine);
        index += 1;
        continue;
      }

      if (VALUE_LINE_REGEX.test(detailLine)) {
        valueLine = detailLine;
        index += 1;
        break;
      }

      const nextOperationMatch = detailLine.match(/^(0\d{3})\s+(.+)$/);
      if (nextOperationMatch) {
        break;
      }

      detailLines.push(detailLine);
      index += 1;
    }

    if (!valueLine) {
      while (index < lines.length) {
        const fallbackLine = lines[index];
        if (!fallbackLine) {
          index += 1;
          continue;
        }
        if (VALUE_LINE_REGEX.test(fallbackLine)) {
          valueLine = fallbackLine;
          index += 1;
        }
        break;
      }
    }

    const operation = buildOperation({
      sequence,
      title,
      bookingDate: currentBookingDate,
      valueLine,
      detailLines,
      currency: statementMeta.account.currency,
    });

    operations.push({
      ...operation,
      rawDetails: {
        detailLines,
        valueLine,
      },
    });
  }

  return operations;
}

function buildOperation({ sequence, title, bookingDate, valueLine, detailLines, currency }) {
  const detailInfo = parseDetailLines(detailLines);
  const valueInfo = parseValueLine(valueLine, bookingDate, currency);

  return {
    sequence,
    title,
    bookingDate: bookingDate || valueInfo.valueDate || null,
    executionDate: detailInfo.executionDate,
    valueDate: valueInfo.valueDate,
    amount: valueInfo.amount,
    currency: valueInfo.currency,
    direction: valueInfo.direction,
    communication: detailInfo.communication,
    bankReference: detailInfo.bankReference,
    orderReference: detailInfo.orderReference,
    counterpartyAccount: detailInfo.counterpartyAccount,
    counterpartyCurrency: detailInfo.counterpartyCurrency,
    counterpartyBic: detailInfo.counterpartyBic,
    counterpartyName: detailInfo.counterpartyName,
    counterpartyAddress: detailInfo.counterpartyAddress,
    additionalDetails: detailInfo.additionalDetails,
  };
}

function parseValueLine(line, bookingDate, currency) {
  if (!line) {
    return {
      valueDate: bookingDate || null,
      amount: null,
      currency,
      direction: null,
    };
  }

  const match = line.match(VALUE_LINE_REGEX);
  if (!match) {
    return {
      valueDate: bookingDate || null,
      amount: null,
      currency,
      direction: null,
    };
  }

  const [, day, month, yearMaybe, amountString, sign] = match;
  const inferredDate = inferValueDate({ day, month, yearMaybe, bookingDate });
  const numericAmount = parseEuropeanNumber(amountString);
  const signedAmount = sign === '-' ? -numericAmount : numericAmount;

  return {
    valueDate: inferredDate,
    amount: signedAmount,
    currency,
    direction: sign === '-' ? 'debit' : 'credit',
  };
}

function parseDetailLines(lines) {
  const details = {
    executionDate: null,
    communication: null,
    bankReference: null,
    orderReference: null,
    counterpartyAccount: null,
    counterpartyCurrency: null,
    counterpartyBic: null,
    counterpartyName: null,
    counterpartyAddress: null,
    additionalDetails: [],
  };

  const residual = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.startsWith('Date d\'exécution')) {
      const consumption = consumeValue(lines, index);
      details.executionDate = toIsoDate(consumption.value);
      index = consumption.nextIndex;
      continue;
    }

    if (line.startsWith('Date de l\'opération')) {
      const consumption = consumeValue(lines, index);
      details.executionDate = toIsoDate(consumption.value);
      index = consumption.nextIndex;
      continue;
    }

    if (line.startsWith('Communication')) {
      const consumption = consumeValue(lines, index);
      details.communication = consumption.value || details.communication;
      index = consumption.nextIndex;
      continue;
    }

    if (line.startsWith('Référence banque')) {
      const consumption = consumeValue(lines, index);
      details.bankReference = consumption.value || details.bankReference;
      index = consumption.nextIndex;
      continue;
    }

    if (line.startsWith('Référence donneur d\'ordre')) {
      const consumption = consumeValue(lines, index);
      details.orderReference = consumption.value || details.orderReference;
      index = consumption.nextIndex;
      continue;
    }

    const ibanParts = parseIbanLine(line);
    if (ibanParts) {
      details.counterpartyAccount = ibanParts.iban;
      details.counterpartyCurrency = ibanParts.currency || details.counterpartyCurrency;
      continue;
    }

    const bicCandidate = line.replace(/\s+/g, '');
    if (BIC_REGEX.test(bicCandidate)) {
      details.counterpartyBic = bicCandidate;
      continue;
    }

    residual.push(line);
  }

  if (residual.length) {
    details.counterpartyName = residual.shift();
    if (residual.length) {
      details.counterpartyAddress = residual.shift();
      if (residual.length) {
        details.additionalDetails.push(...residual);
      }
    }
  }

  return details;
}

function consumeValue(lines, startIndex) {
  const line = lines[startIndex] || '';
  const colonIndex = line.indexOf(':');
  let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1).trim();
  let nextIndex = startIndex;

  if (!value) {
    for (let cursor = startIndex + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor];
      if (!candidate) {
        continue;
      }
      if (candidate.includes(':')) {
        break;
      }
      value = candidate.trim();
      nextIndex = cursor;
      break;
    }
  }

  return { value, nextIndex };
}

function parseIbanLine(line) {
  const compact = line.replace(/\s+/g, '');
  if (compact.length < IBAN_MIN_LENGTH) {
    return null;
  }
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(compact)) {
    return null;
  }

  const matches = line.trim().split(/\s+/);
  if (!matches.length) {
    return null;
  }

  const currencyCandidate = matches[matches.length - 1];
  if (/^[A-Z]{3}$/.test(currencyCandidate)) {
    return {
      iban: compact.slice(0, -currencyCandidate.length),
      currency: currencyCandidate,
    };
  }

  return {
    iban: compact,
    currency: null,
  };
}

function parseAccountLine(line) {
  const matches = line.trim().split(/\s+/);
  if (!matches.length) {
    throw new Error('Invalid account line in statement.');
  }

  const currencyCandidate = matches[matches.length - 1];
  const hasCurrency = /^[A-Z]{3}$/.test(currencyCandidate);
  const ibanParts = matches.slice(0, hasCurrency ? -1 : undefined).join('');

  return {
    iban: ibanParts,
    currency: hasCurrency ? currencyCandidate : null,
  };
}

function parseStatementTitle(line) {
  if (!line) {
    return {
      statementNumber: null,
      statementYear: null,
    };
  }

  const match = line.match(/Extrait N°\s+(\d{4})\s*-\s*(\d+)/);
  if (!match) {
    return {
      statementNumber: null,
      statementYear: null,
    };
  }

  return {
    statementYear: match[1],
    statementNumber: match[2],
  };
}

function parseBalanceLine(line) {
  if (!line) {
    return {
      date: null,
      amount: null,
    };
  }

  const match = line.match(/au\s+(\d{2}-\d{2}-\d{4})\s+([\d.,]+)\s*([+-])/);
  if (!match) {
    return {
      date: null,
      amount: null,
    };
  }

  const [, datePart, amountPart, sign] = match;
  const numericAmount = parseEuropeanNumber(amountPart);
  const signedAmount = sign === '-' ? -numericAmount : numericAmount;

  return {
    date: toIsoDate(datePart),
    amount: signedAmount,
  };
}

function isPotentialIbanLine(line) {
  return /^[A-Z]{2}\d{2}/.test(line) && line.length > IBAN_MIN_LENGTH;
}

function toIsoDate(dateString) {
  if (!dateString) {
    return null;
  }
  const match = dateString.match(ISO_DATE_REGEX);
  if (!match) {
    return null;
  }
  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
}

function inferValueDate({ day, month, yearMaybe, bookingDate }) {
  if (yearMaybe) {
    return `${yearMaybe}-${month}-${day}`;
  }
  if (bookingDate) {
    const [bookingYear, bookingMonth] = bookingDate.split('-').map((part) => parseInt(part, 10));
    const valueMonth = parseInt(month, 10);
    let year = bookingYear;
    const monthDelta = valueMonth - bookingMonth;
    if (monthDelta < -6) {
      year += 1;
    } else if (monthDelta > 6) {
      year -= 1;
    }
    return `${year}-${month}-${day}`;
  }
  return null;
}

function parseEuropeanNumber(raw) {
  if (!raw) {
    return 0;
  }
  const normalized = raw.replace(/\./g, '').replace(/\s+/g, '').replace(',', '.');
  const parsed = parseFloat(normalized);
  return Number.isNaN(parsed) ? 0 : parsed;
}

async function writeStatementJson(statement, outputDir, overwrite) {
  const baseName = statement.statementId || buildFileSafeName(statement.source.entryName || statement.source.originPath);
  const fileName = `${baseName}.json`;
  const targetPath = path.join(outputDir, fileName);

  if (!overwrite && fs.existsSync(targetPath)) {
    throw new Error(`File already exists at ${targetPath}. Use --overwrite to replace it.`);
  }

  await fsPromises.writeFile(targetPath, JSON.stringify(statement, null, 2), 'utf8');
  return targetPath;
}

function buildStatementId(meta, context) {
  if (meta.statementYear && meta.statementNumber) {
    const accountSegment = meta.account.iban ? meta.account.iban.slice(-6) : 'account';
    return `${accountSegment}-${meta.statementYear}-${padLeft(meta.statementNumber, 3)}`;
  }
  if (context.entryName) {
    return buildFileSafeName(path.basename(context.entryName, '.pdf'));
  }
  if (context.originPath) {
    return buildFileSafeName(path.basename(context.originPath, '.pdf'));
  }
  return `statement-${Date.now()}`;
}

function padLeft(value, length) {
  return value.toString().padStart(length, '0');
}

function buildFileSafeName(value) {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

async function emitAggregatedIndex(statements, outputDir) {
  const operations = [];

  for (const statement of statements) {
    const reference = {
      statementId: statement.statementId,
      statementFile: path.basename(statement.outputPath),
      accountIban: statement.account.iban,
      accountName: statement.account.name,
      statementYear: statement.statementYear,
      statementNumber: statement.statementNumber,
    };

    for (const op of statement.operations) {
      operations.push({
        ...reference,
        sequence: op.sequence,
        title: op.title,
        bookingDate: op.bookingDate,
        executionDate: op.executionDate,
        valueDate: op.valueDate,
        amount: op.amount,
        currency: op.currency,
        direction: op.direction,
        communication: op.communication,
        bankReference: op.bankReference,
        orderReference: op.orderReference,
        counterpartyAccount: op.counterpartyAccount,
        counterpartyBic: op.counterpartyBic,
        counterpartyName: op.counterpartyName,
        counterpartyAddress: op.counterpartyAddress,
      });
    }
  }

  const indexPayload = {
    generatedAt: new Date().toISOString(),
    operations,
  };

  const indexPath = path.join(outputDir, 'operations-index.json');
  await fsPromises.writeFile(indexPath, JSON.stringify(indexPayload, null, 2), 'utf8');
}

function reportSummary(statements, failures) {
  const totalOperations = statements.reduce((sum, statement) => sum + statement.operations.length, 0);
  console.log(`Processed ${statements.length} statement(s), extracted ${totalOperations} operation(s).`);
  statements.forEach((statement) => {
    console.log(`- ${statement.statementId}: ${statement.operations.length} operation(s) -> ${statement.outputPath}`);
  });

  if (failures.length) {
    console.error(`Encountered ${failures.length} error(s):`);
    failures.forEach((failure) => {
      if (failure.source === 'zip') {
        console.error(`  • ${failure.zipPath} :: ${failure.entryName} -> ${failure.error}`);
      } else {
        console.error(`  • ${failure.pdfPath} -> ${failure.error}`);
      }
    });
  }
}

main();
