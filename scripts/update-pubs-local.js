const fs = require("fs");
const path = require("path");

const ZOTERO_API = "http://localhost:23119/api";
const COLLECTION_NAME = "GMDN Publications";

const OUT_DIR = path.join(process.cwd(), "publications");

const OWNER_FAMILY = "di nunzio";
const OWNER_GIVEN_PREFIX = "giorgio maria";


// ------------------------------------------------------------
// Zotero local API
// ------------------------------------------------------------

async function zoteroFetchJSON(apiPath) {
  const response = await fetch(`${ZOTERO_API}${apiPath}`, {
    headers: {
      "Zotero-API-Version": "3"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Zotero API error: ${response.status} ${response.statusText}`
    );
  }

  return response.json();
}


async function zoteroFetchText(apiPath) {
  const response = await fetch(`${ZOTERO_API}${apiPath}`, {
    headers: {
      "Zotero-API-Version": "3"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Zotero API error: ${response.status} ${response.statusText}`
    );
  }

  return response.text();
}


// ------------------------------------------------------------
// Utility functions
// ------------------------------------------------------------

function slugify(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}


function yq(s) {
  return JSON.stringify(String(s ?? ""));
}


function isOwner(c) {
  if (!c) return false;

  const family = (c.lastName || "").trim().toLowerCase();
  const given = (c.firstName || "").trim().toLowerCase();

  if (
    family === OWNER_FAMILY &&
    given.startsWith(OWNER_GIVEN_PREFIX)
  ) {
    return true;
  }

  if (c.name) {
    const s = slugify(c.name);

    if (
      s === "giorgio-maria-di-nunzio" ||
      s === "giorgio-di-nunzio"
    ) {
      return true;
    }
  }

  return false;
}


function initials(firstName = "") {
  return firstName
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean)
    .map(part => `${part.charAt(0).toUpperCase()}.`)
    .join(" ");
}


function citeName(c) {
  if (!c) return "";

  let name;

  if (c.name) {
    name = c.name;
  } else {
    const family = c.lastName || "";
    const given = initials(c.firstName || "");

    name = family && given
      ? `${family}, ${given}`
      : family || c.firstName || "";
  }

  if (isOwner(c)) {
    return `<strong>${name}</strong>`;
  }

  return name;
}


function joinAuthors(authors) {
  if (!authors.length) return "";

  if (authors.length === 1) {
    return authors[0];
  }

  if (authors.length === 2) {
    return `${authors[0]} & ${authors[1]}`;
  }

  return `${authors.slice(0, -1).join(", ")}, & ${authors.at(-1)}`;
}


function getYear(dateString) {
  const match = String(dateString || "").match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : "";
}


function firstAuthorSlug(item) {
  const creators = item.data.creators || [];

  const author = creators.find(
    c => c.creatorType === "author" && (c.lastName || c.name)
  );

  if (!author) return "publication";

  return slugify(author.lastName || author.name);
}


const STOP_WORDS = new Set([
  "a", "an", "and", "as", "at", "by", "for", "from",
  "in", "into", "of", "on", "or", "the", "to", "with"
]);


function titleSlug(title, maxWords = 3) {
  const words = slugify(title)
    .split("-")
    .filter(Boolean)
    .filter(word => !STOP_WORDS.has(word));

  return words.slice(0, maxWords).join("-");
}


function publicationSlug(item) {
  const author = firstAuthorSlug(item);
  const title = titleSlug(item.data.title || "");
  const year = getYear(item.data.date || "");

  const shortYear = year ? year.slice(-2) : "";

  return [author, title, shortYear]
    .filter(Boolean)
    .join("-");
}


// ------------------------------------------------------------
// Publication metadata
// ------------------------------------------------------------

const TYPE_MAP = {
  journalArticle: "Journal Article",
  conferencePaper: "Conference Paper",
  book: "Book",
  bookSection: "Book Chapter",
  thesis: "Thesis",
  report: "Report",
  preprint: "Preprint",
  presentation: "Presentation"
};


function categorize(item) {
  return TYPE_MAP[item.data.itemType] || "Other";
}


function getVenue(d) {
  return (
    d.publicationTitle ||
    d.proceedingsTitle ||
    d.bookTitle ||
    d.university ||
    d.institution ||
    d.publisher ||
    ""
  );
}


// ------------------------------------------------------------
// PDF attachments
// ------------------------------------------------------------

async function getPdfAttachments(itemKey) {
  const children = await zoteroFetchJSON(
    `/users/0/items/${itemKey}/children`
  );

  const pdfAttachments = children.filter(child => {
    return (
      child.data.itemType === "attachment" &&
      child.data.contentType === "application/pdf"
    );
  });

  const results = [];

  for (const attachment of pdfAttachments) {
    try {
      const fileUrl = await zoteroFetchText(
        `/users/0/items/${attachment.key}/file/view/url`
      );

      results.push({
        key: attachment.key,
        title: attachment.data.title,
        filename: attachment.data.filename,
        linkMode: attachment.data.linkMode,
        tags: attachment.data.tags || [],
        fileUrl: fileUrl.trim()
      });

    } catch (error) {
      results.push({
        key: attachment.key,
        title: attachment.data.title,
        filename: attachment.data.filename,
        linkMode: attachment.data.linkMode,
        tags: attachment.data.tags || [],
        fileUrl: null,
        error: error.message
      });
    }
  }

  return results;
}


// ------------------------------------------------------------
// Choose PDF for website
// ------------------------------------------------------------

function selectWebsitePdf(pdfs) {

  // Remove PDFs explicitly hidden from the website
  const usablePdfs = pdfs.filter(pdf =>
    !(pdf.tags || []).some(
      tag => tag.tag === "website-hide-pdf"
    )
  );

  // No usable PDF
  if (usablePdfs.length === 0) {
    return {
      pdf: null,
      reason: "none-available"
    };
  }

  // Exactly one usable PDF: use it
  if (usablePdfs.length === 1) {
    return {
      pdf: usablePdfs[0],
      reason: "single"
    };
  }

  // More than one usable PDF:
  // look for exactly one website-pdf tag
  const preferred = usablePdfs.filter(pdf =>
    (pdf.tags || []).some(
      tag => tag.tag === "website-pdf"
    )
  );

  if (preferred.length === 1) {
    return {
      pdf: preferred[0],
      reason: "tagged"
    };
  }

  // Ambiguous
  return {
    pdf: null,
    reason:
      preferred.length > 1
        ? "multiple-tagged"
        : "multiple-no-tag"
  };
}


// ------------------------------------------------------------
// Convert Zotero local file URL to filesystem path
// ------------------------------------------------------------

function localPathFromFileUrl(fileUrl) {
  if (!fileUrl) return null;

  try {
    const url = new URL(fileUrl);

    if (url.protocol === "file:") {
      return decodeURIComponent(url.pathname);
    }
  } catch (_) {
    // It may already be a normal filesystem path.
  }

  return fileUrl;
}


// ------------------------------------------------------------
// Retrieve all items from collection
// ------------------------------------------------------------

async function getAllCollectionItems(collectionKey) {
  const allItems = [];
  const limit = 100;

  let start = 0;

  while (true) {
    const items = await zoteroFetchJSON(
      `/users/0/collections/${collectionKey}/items/top` +
      `?limit=${limit}&start=${start}`
    );

    allItems.push(...items);

    if (items.length < limit) {
      break;
    }

    start += limit;
  }

  return allItems;
}


// ------------------------------------------------------------
// Helpers to retrieve BibTeX for one item
// ------------------------------------------------------------

function bibtexEscape(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%#$])/g, "\\$1")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}");
}


function bibtexAuthors(creators = []) {
  return creators
    .filter(c =>
      c &&
      c.creatorType === "author" &&
      (c.lastName || c.name)
    )
    .map(c => {
      if (c.name) {
        return bibtexEscape(c.name);
      }

      const family = bibtexEscape(c.lastName || "");
      const given = bibtexEscape(c.firstName || "");

      return family && given
        ? `${family}, ${given}`
        : family || given;
    })
    .join(" and ");
}


function bibtexEntryType(itemType) {
  const map = {
    journalArticle: "article",
    conferencePaper: "inproceedings",
    book: "book",
    bookSection: "incollection",
    thesis: "phdthesis",
    report: "techreport",
    preprint: "misc",
    presentation: "misc"
  };

  return map[itemType] || "misc";
}


function buildBibTeX(item) {
  const d = item.data;

  const type = bibtexEntryType(d.itemType);

  const key =
    d.citationKey ||
    publicationSlug(item) ||
    `publication-${item.key.toLowerCase()}`;

  const fields = [];

  const add = (name, value, options = {}) => {
    if (value == null || String(value).trim() === "") {
      return;
    }

    let text = bibtexEscape(String(value).trim());

    // Protect capitalization of titles from BibTeX styles
    if (options.protectCase) {
      text = `{${text}}`;
    }

    fields.push(`  ${name} = {${text}}`);
  };

  const authors = bibtexAuthors(d.creators || []);

  if (authors) {
    fields.push(`  author = {${authors}}`);
  }

  add("title", d.title, { protectCase: true });

  switch (d.itemType) {

    case "journalArticle":
      add("journal", d.publicationTitle, { protectCase: true });
      break;
  
    case "conferencePaper":
      add(
        "booktitle",
        d.proceedingsTitle ||
        d.conferenceName ||
        d.meetingName ||
        d.event,
        { protectCase: true }
      );
      break;
  
    case "bookSection":
      add("booktitle", d.bookTitle, { protectCase: true });
      add("publisher", d.publisher, { protectCase: true });
      break;
  
    case "book":
      add("publisher", d.publisher, { protectCase: true });
      break;
  
    case "thesis":
      add("school", d.university || d.publisher);
      break;
  
    case "report":
      add("institution", d.institution || d.publisher);
      add("number", d.reportNumber);
      break;
  }

  const year = getYear(d.date);

  add("year", year);
  add("volume", d.volume);
  add("number", d.issue);
  add("pages", d.pages);
  add("doi", d.DOI);
  add("url", d.url);

  return [
    `@${type}{${key},`,
    fields.join(",\n"),
    `}`
  ].join("\n");
}





// ------------------------------------------------------------
// Main
// ------------------------------------------------------------

async function main() {

  // ----------------------------------------------------------
  // 1. Retrieve collections
  // ----------------------------------------------------------

  const collections = await zoteroFetchJSON(
    "/users/0/collections?limit=100"
  );


  // ----------------------------------------------------------
  // 2. Find GMDN Publications
  // ----------------------------------------------------------

  const collection = collections.find(
    c => c.data.name === COLLECTION_NAME
  );

  if (!collection) {
    console.error(
      `Collection "${COLLECTION_NAME}" not found.`
    );

    process.exit(1);
  }

  console.log(`Found collection: ${collection.data.name}`);
  console.log(`Collection key: ${collection.key}`);


  // ----------------------------------------------------------
  // 3. Retrieve all publications
  // ----------------------------------------------------------

  const items = await getAllCollectionItems(collection.key);

  console.log(`\nFound ${items.length} publications.\n`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const generatedSlugs = new Set();

  let written = 0;
  let copiedPdfs = 0;
  let ambiguousPdfs = 0;


  // ----------------------------------------------------------
  // 4. Generate publication directories
  // ----------------------------------------------------------

  for (const item of items) {

    const d = item.data;

    const title = d.title || "Untitled";
    const date = d.date || "";
    const summary = d.abstractNote || "";

    const category = categorize(item);

    const authorsHtml = joinAuthors(
      (d.creators || [])
        .filter(
          c =>
            c &&
            c.creatorType === "author" &&
            (c.lastName || c.name)
        )
        .map(citeName)
    );

    const venue = getVenue(d);

    const detailBits = [];

    if (d.volume) {
      detailBits.push(`vol. ${d.volume}`);
    }

    if (d.issue) {
      detailBits.push(`no. ${d.issue}`);
    }

    if (d.pages) {
      detailBits.push(`pp. ${d.pages}`);
    }

    const doi = (d.DOI || "").trim();

    const link =
      (d.url || "").trim();


    // --------------------------------------------------------
    // Zotero tags controlling website behaviour
    // --------------------------------------------------------

    const tags = (d.tags || []).map(t => t.tag);

    const featured =
      tags.includes("website-featured");


    // --------------------------------------------------------
    // Stable publication slug
    // --------------------------------------------------------

    let slug = publicationSlug(item);

    if (!slug) {
      slug = `publication-${item.key.toLowerCase()}`;
    }

    if (generatedSlugs.has(slug)) {
      slug =
        `${slug}-${item.key.toLowerCase().slice(0, 4)}`;
    }

    generatedSlugs.add(slug);

    const dir = path.join(OUT_DIR, slug);

    fs.mkdirSync(dir, { recursive: true });


    // --------------------------------------------------------
    // Find PDF
    // --------------------------------------------------------

    const pdfs = await getPdfAttachments(item.key);

    const selection = selectWebsitePdf(pdfs);

    let pubPdf = null;

    if (selection.pdf) {

      const sourcePath =
        localPathFromFileUrl(selection.pdf.fileUrl);

      if (sourcePath && fs.existsSync(sourcePath)) {

        const destination =
          path.join(dir, "paper.pdf");

        fs.copyFileSync(
          sourcePath,
          destination
        );

        pubPdf = "paper.pdf";
        copiedPdfs++;

        console.log(
          `PDF ${slug}: ${selection.pdf.filename} ` +
          `(${selection.reason})`
        );

      } else {

        console.warn(
          `PDF ${slug}: copy failed; file not found: ` +
          `${sourcePath}`
        );
      }

    } else {

      if (
        selection.reason === "multiple-tagged" ||
        selection.reason === "multiple-no-tag"
      ) {
        ambiguousPdfs++;
      }

      console.log(
        `PDF ${slug}: not published (${selection.reason})`
      );
    }


    // --------------------------------------------------------
    // Build YAML front matter
    // --------------------------------------------------------

    const fm = [
      "---",
      `title: ${yq(title)}`
    ];

    if (date) {
      fm.push(`date: ${yq(date)}`);
    }

    if (summary) {
      fm.push(`description-meta: ${yq(summary)}`);
    }

    fm.push(
      `categories: [${yq(category)}]`
    );

    if (featured) {
      fm.push(`featured: true`);
    }

    if (authorsHtml) {
      fm.push(
        `pub-authors: ${yq(authorsHtml)}`
      );
    }

    if (venue) {
      fm.push(
        `pub-venue: ${yq(venue)}`
      );
    }

    if (detailBits.length) {
      fm.push(
        `pub-details: ${yq(detailBits.join(", "))}`
      );
    }

    if (doi) {
      fm.push(
        `pub-doi: ${yq(doi)}`
      );
    }

    if (link) {
      fm.push(
        `pub-url: ${yq(link)}`
      );
    }

    if (pubPdf) {
      fm.push(
        `pub-pdf: ${yq(pubPdf)}`
      );
    }

    fm.push("---", "");


    // --------------------------------------------------------
    // Publication page
    // --------------------------------------------------------

    const body = [];

    if (authorsHtml) {
      body.push(
        `<p class="nw-pub-authors">${authorsHtml}</p>`,
        ""
      );
    }

    if (venue) {

      let venueText = `<em>${venue}</em>`;

      if (detailBits.length) {
        venueText += `, ${detailBits.join(", ")}`;
      }

      body.push(
        `<p class="nw-pub-venue">${venueText}</p>`,
        ""
      );
    }


    // --------------------------------------------------------
    // Buttons
    // --------------------------------------------------------

    const buttons = [];

    if (pubPdf) {
      buttons.push(
        `[PDF](paper.pdf){.nw-btn .nw-btn-primary target="_blank"}`
      );
    }

    if (doi) {
      buttons.push(
        `[DOI](https://doi.org/${doi}){.nw-btn target="_blank"}`
      );
    } else if (link) {
      buttons.push(
        `[Source](${link}){.nw-btn target="_blank"}`
      );
    }

    buttons.push(
      `[BibTeX](cite.bib){.nw-btn target="_blank"}`
    );

    if (buttons.length) {
      body.push(
        buttons.join(" "),
        ""
      );
    }


    // --------------------------------------------------------
    // Abstract
    // --------------------------------------------------------

    if (summary) {
      body.push(
        "## Abstract",
        "",
        summary,
        ""
      );
    }


    // --------------------------------------------------------
    // Write index.qmd
    // --------------------------------------------------------

    fs.writeFileSync(
      path.join(dir, "index.qmd"),
      [...fm, ...body].join("\n"),
      "utf8"
    );


    // --------------------------------------------------------
    // Write cite.bib
    // --------------------------------------------------------

    const bibtex = buildBibTeX(item);

    fs.writeFileSync(
      path.join(dir, "cite.bib"),
      bibtex + "\n",
      "utf8"
    );

    written++;
  }


  // ----------------------------------------------------------
  // 5. Prune obsolete generated publication directories
  // ----------------------------------------------------------

  let pruned = 0;

  for (const entry of fs.readdirSync(
    OUT_DIR,
    { withFileTypes: true }
  )) {

    if (!entry.isDirectory()) {
      continue;
    }

    if (!generatedSlugs.has(entry.name)) {

      fs.rmSync(
        path.join(OUT_DIR, entry.name),
        {
          recursive: true,
          force: true
        }
      );

      pruned++;
    }
  }


  // ----------------------------------------------------------
  // Summary
  // ----------------------------------------------------------

  console.log("");
  console.log(
    `Wrote ${written} publications; ` +
    `copied ${copiedPdfs} PDFs; ` +
    `${ambiguousPdfs} ambiguous PDF selections; ` +
    `pruned ${pruned}.`
  );
}


main().catch(error => {
  console.error(error);
  process.exit(1);
});