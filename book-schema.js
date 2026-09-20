import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc } from "firebase/firestore";

const CLOUD_NAME = "dzoq4pgjn";

function bookPageUrl(bookId) {
  return `${window.location.origin}${window.location.pathname}?id=${encodeURIComponent(bookId)}`;
}

const firebaseConfig = {
  apiKey: "AIzaSyC4DHI8aBVY4JjTvJ-r-TGIDPsewtEWxzU",
  authDomain: "silent-depth.firebaseapp.com",
  projectId: "silent-depth",
  storageBucket: "silent-depth.appspot.com",
  messagingSenderId: "78008755450",
  appId: "1:78008755450:web:3fd0f0f298a08820935543"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

function formatDate(value) {
  if (value === undefined || value === null) return null;
  try {
    let date;
    if (typeof value.toDate === "function") {
      date = value.toDate();
    } else if (typeof value === "number") {
      const ms = value < 1e12 ? value * 1000 : value;
      date = new Date(ms);
    } else if (typeof value === "string" && value.trim() !== "") {
      date = new Date(value);
    } else {
      return null;
    }
    if (isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
  } catch (err) {
    return null;
  }
}

function pickImage(data) {
  if (data.imageUrl) return data.imageUrl;
  if (data.coverUrl) return data.coverUrl;
  if (data.cloudinaryImageId) {
    return `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/f_auto,q_auto/${data.cloudinaryImageId}`;
  }
  return null;
}

function buildBookSchema(data, bookId) {
  const pageUrl = bookPageUrl(bookId);

  const schema = {
    "@context": "https://schema.org",
    "@type": "Book",
    "@id": pageUrl,
    "url": pageUrl,
    "name": data.title,
    "bookFormat": "https://schema.org/EBook",
    "availability": "https://schema.org/InStock",
    "inLanguage": data.languageCode || data.language || "en",
    "publisher": {
      "@type": "Organization",
      "name": "Volant Foundry",
      "url": "https://volantfoundry.vercel.app/"
    }
  };

  const image = pickImage(data);
  if (image) schema.image = image;

  const author = {
    "@type": "Person",
    "name": data.authorName || data.author || "Anonymous"
  };
  if (data.authorPoetryProfile) author.sameAs = data.authorPoetryProfile;
  schema.author = author;

  const datePublished = formatDate(data.publishDate || data.publishedAt || data.createdAt || data.approvedAt);
  if (datePublished) schema.datePublished = datePublished;

  const description = data.summary || data.description;
  if (description) schema.description = description;

  if (data.isbn13) schema.isbn = data.isbn13;

  const ratingValue = data.ratingValue || data.rating?.value;
  const reviewCount = data.reviewCount || data.rating?.count;
  if (Number(ratingValue) > 0 && Number(reviewCount) > 0) {
    schema.aggregateRating = {
      "@type": "AggregateRating",
      "ratingValue": Number(ratingValue),
      "reviewCount": Number(reviewCount)
    };
  }

  const price = data.pricing?.amount ?? data.price;
  if (price !== undefined && price !== null && price !== "") {
    schema.offers = {
      "@type": "Offer",
      "price": price,
      "priceCurrency": data.pricing?.currency ?? data.currency ?? "GHS"
    };
  }

  return JSON.stringify(schema);
}

export async function injectBookSchema(bookId) {
  const target = document.getElementById("structured-data-book");
  if (!target) {
    console.warn("[book-schema] No <script id=\"structured-data-book\"> element found.");
    return;
  }
  let docSnap;
  try {
    docSnap = await getDoc(doc(db, "books", bookId));
  } catch (err) {
    console.warn("[book-schema] Could not fetch book " + bookId + ":", err);
    return;
  }
  if (!docSnap.exists() || docSnap.data().status !== "approved") {
    console.warn("[book-schema] Book missing or not approved: " + bookId);
    return;
  }
  const data = docSnap.data();
  target.textContent = buildBookSchema(data, bookId);
}

(function autoRun() {
  const bookId = new URLSearchParams(window.location.search).get("id");
  if (!bookId) return;
  injectBookSchema(bookId).catch(function (err) {
    console.warn("[book-schema] Auto-run failed:", err);
  });
})();