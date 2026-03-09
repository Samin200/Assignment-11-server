require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const axios = require("axios");
const FormData = require("form-data");
const admin = require("firebase-admin");

const app = express();
const port = process.env.PORT || 5020;

// ================= FIREBASE ADMIN SDK =================
try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
  console.log("Firebase Admin SDK initialized successfully");
} catch (err) {
  console.error("Firebase Admin SDK initialization failed:", err.message);
}

// ================= MIDDLEWARE =================
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ================= WEBHOOK (MUST BE FIRST - RAW BODY) =================
let ordersCollection;

app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const orderId = session.metadata?.orderId;
      if (orderId) {
        await ordersCollection.updateOne(
          { _id: new ObjectId(orderId) },
          { $set: { paymentStatus: "paid", status: "completed", paidAt: new Date() } }
        );
        console.log("Order marked PAID:", orderId);
      }
    }

    res.json({ received: true });
  }
);

// ================= MONGODB =================
const client = new MongoClient(process.env.MONGO_URI, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

let booksCollection;
let usersCollection;
let librarianRequestsCollection;
let wishlistsCollection;
let reviewsCollection;

async function run() {
  try {
    await client.connect();
    console.log("MongoDB Connected Successfully");

    const db = client.db("bookcourier");
    booksCollection = db.collection("books");
    ordersCollection = db.collection("orders");
    usersCollection = db.collection("users");
    librarianRequestsCollection = db.collection("librarianRequests");
    wishlistsCollection = db.collection("wishlists");
    reviewsCollection = db.collection("reviews");

    // ================= TOKEN VERIFICATION MIDDLEWARE =================
    const verifyToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Unauthorized - No token provided" });
      }

      const idToken = authHeader.split("Bearer ")[1];

      try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = decodedToken;

        const dbUser = await usersCollection.findOne({ uid: decodedToken.uid });
        req.user.role = dbUser?.role || "user";

        console.log(`[TOKEN] UID: ${decodedToken.uid} | Email: ${decodedToken.email} | Role: ${req.user.role}`);
        next();
      } catch (err) {
        console.error("[TOKEN] Verification failed:", err.code || "unknown", err.message);
        return res.status(401).json({ error: "Unauthorized - Invalid token" });
      }
    };

    // ================= ROOT =================
    app.get("/", (req, res) => res.send("BookCourier API is running 🚀"));

    // ================= PUBLIC ROUTES =================
    app.get("/books", async (req, res) => {
      const { addedBy, search } = req.query;
      let query = {};
      if (addedBy) query.addedBy = addedBy;
      if (search) query.bookName = { $regex: search, $options: "i" };
      const books = await booksCollection.find(query).toArray();
      res.json(books);
    });

    app.get("/books/:id", async (req, res) => {
      try {
        const book = await booksCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!book) return res.status(404).json({ error: "Book not found" });
        res.json(book);
      } catch {
        res.status(400).json({ error: "Invalid book ID" });
      }
    });

    app.post("/create-checkout-session", async (req, res) => {
      const { orderId, bookName, price } = req.body;
      if (!orderId || !bookName || price == null) {
        return res.status(400).json({ error: "Missing required fields" });
      }
      try {
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: [{
            price_data: {
              currency: "usd",
              product_data: { name: bookName },
              unit_amount: Math.round(price * 100),
            },
            quantity: 1,
          }],
          mode: "payment",
          success_url: `${process.env.FRONTEND_URL || "http://localhost:5173"}/my-orders?payment=success`,
          cancel_url: `${process.env.FRONTEND_URL || "http://localhost:5173"}/my-orders?payment=cancelled`,
          metadata: { orderId: orderId.toString() },
        });
        res.json({ url: session.url });
      } catch (err) {
        console.error("Stripe session error:", err.message);
        res.status(500).json({ error: "Failed to create checkout session" });
      }
    });

    // ================= USER ROUTES =================
    app.post("/api/user", async (req, res) => {
      const { email, displayName, uid, photoURL } = req.body;
      if (!email) return res.status(400).json({ error: "Email required" });
      try {
        let user = await usersCollection.findOne({ email });
        if (!user) {
          const newUser = {
            uid,
            email,
            displayName: displayName || "User",
            photoURL: photoURL || "",
            role: "user",
            createdAt: new Date(),
          };
          const result = await usersCollection.insertOne(newUser);
          user = { _id: result.insertedId, ...newUser };
        } else if (photoURL && !user.photoURL) {
          await usersCollection.updateOne({ email }, { $set: { photoURL } });
          user.photoURL = photoURL;
        }
        res.json({ _id: user._id, email: user.email, displayName: user.displayName, role: user.role, photoURL: user.photoURL });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to sync user" });
      }
    });

    app.get("/api/users", verifyToken, async (req, res) => {
      try {
        const users = await usersCollection.find({}).toArray();
        res.json(users);
      } catch (err) {
        res.status(500).json({ error: "Failed to fetch users" });
      }
    });

    app.patch("/api/users/:id/role", verifyToken, async (req, res) => {
      const { role } = req.body;
      if (!["user", "librarian", "admin"].includes(role)) {
        return res.status(400).json({ error: "Invalid role" });
      }
      try {
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { role } }
        );
        if (result.matchedCount === 0) return res.status(404).json({ error: "User not found" });
        res.json({ message: "Role updated successfully" });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to update role" });
      }
    });

    app.delete("/api/users/:id", verifyToken, async (req, res) => {
      if (req.user.role !== "admin") {
        return res.status(403).json({ error: "Only admins can delete users." });
      }
      try {
        const target = await usersCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!target) return res.status(404).json({ error: "User not found" });

        if (target.uid === req.user.uid) {
          return res.status(400).json({ error: "You cannot delete your own account." });
        }

        await usersCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        await ordersCollection.deleteMany({ email: target.email });

        res.json({ message: "User deleted successfully" });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to delete user" });
      }
    });

    // ================= LIBRARIAN REQUEST ROUTES =================
    app.get("/api/librarian-requests", verifyToken, async (req, res) => {
      try {
        const requests = await librarianRequestsCollection.find().toArray();
        res.json(requests);
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
      }
    });

    app.patch("/api/librarian-requests/:id", verifyToken, async (req, res) => {
      const { status } = req.body;
      if (!["approved", "rejected"].includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      try {
        const requestId = req.params.id;
        const request = await librarianRequestsCollection.findOne({ _id: new ObjectId(requestId) });
        if (!request) return res.status(404).json({ error: "Request not found" });

        await librarianRequestsCollection.updateOne(
          { _id: new ObjectId(requestId) },
          { $set: { status, updatedAt: new Date() } }
        );

        if (status === "approved") {
          await usersCollection.updateOne({ uid: request.userId }, { $set: { role: "librarian" } });
        }

        res.json({ success: true });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
      }
    });

    app.get("/api/my-librarian-request", verifyToken, async (req, res) => {
      const { uid } = req.query;
      if (!uid) return res.status(400).json({ error: "UID required" });
      try {
        const request = await librarianRequestsCollection.findOne({ userId: uid });
        if (!request) return res.status(404).json({ status: null });
        res.json({ status: request.status, requestedAt: request.requestedAt });
      } catch (err) {
        res.status(500).json({ error: "Failed to check request status" });
      }
    });

    app.post("/api/become-librarian", async (req, res) => {
      const { userId, reason } = req.body;
      if (!userId) return res.status(400).json({ error: "User ID required" });
      if (!reason || reason.trim().length < 10) {
        return res.status(400).json({ error: "Please provide a reason (min 10 characters)" });
      }
      try {
        const user = await usersCollection.findOne({ uid: userId });
        if (!user) return res.status(404).json({ error: "User not found" });

        const existingRequest = await librarianRequestsCollection.findOne({ userId });
        if (existingRequest) {
          if (existingRequest.status === "pending") return res.status(400).json({ error: "Your request is already pending." });
          if (existingRequest.status === "approved") return res.status(400).json({ error: "You are already a librarian!" });
        }

        const request = {
          userId,
          userInfo: req.body.userInfo || { email: user.email, displayName: user.displayName || "User" },
          reason: reason.trim(),
          status: "pending",
          requestedAt: new Date(),
          updatedAt: new Date(),
        };

        if (existingRequest?.status === "rejected") {
          await librarianRequestsCollection.updateOne({ _id: existingRequest._id }, { $set: request });
          return res.json({ success: true, message: "Request re-submitted" });
        }

        const result = await librarianRequestsCollection.insertOne(request);
        res.json({ success: true, requestId: result.insertedId });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
      }
    });

    // ================= BOOK ROUTES =================
    app.post("/books", verifyToken, async (req, res) => {
      const { bookName, authorName, bookImage, description, category, price, pages, rating, addedBy, status = "published" } = req.body;
      if (!bookName || !authorName || !price || !bookImage || !addedBy) {
        return res.status(400).json({ error: "Missing required fields" });
      }
      try {
        const newBook = {
          bookName: bookName.trim(),
          authorName: authorName.trim(),
          bookImage,
          description: description?.trim() || "",
          category: category?.trim() || "",
          price: Number(price),
          pages: pages ? Number(pages) : 0,
          rating: rating ? Number(rating) : 0,
          addedBy,
          status,
          addedAt: new Date(),
        };
        const result = await booksCollection.insertOne(newBook);
        res.status(201).json({ message: "Book added successfully", bookId: result.insertedId });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to add book" });
      }
    });

    app.patch("/books/:id", verifyToken, async (req, res) => {
      const { status } = req.body;
      if (!["published", "unpublished"].includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      try {
        const book = await booksCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!book) return res.status(404).json({ error: "Book not found" });

        if (book.adminLocked && status === "published" && req.user.role !== "admin") {
          return res.status(403).json({
            error: "This book was unpublished by an admin and cannot be republished without admin approval.",
            adminLocked: true,
          });
        }

        const update = { status };
        if (req.user.role === "admin") {
          update.adminLocked = status === "unpublished";
        }

        await booksCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: update });
        res.json({ message: "Book status updated", adminLocked: update.adminLocked ?? book.adminLocked });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to update book" });
      }
    });

    app.put("/books/:id", verifyToken, async (req, res) => {
      const { bookName, authorName, bookImage, description, category, price, pages, rating, status } = req.body;

      if (!bookName || !authorName || !price || !bookImage) {
        return res.status(400).json({ error: "Missing required fields: title, author, price, and cover image are required." });
      }

      try {
        const book = await booksCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!book) return res.status(404).json({ error: "Book not found" });

        if (req.user.role !== "admin" && book.addedBy !== req.user.email) {
          return res.status(403).json({ error: "You can only edit books you added." });
        }

        const newStatus = ["published", "unpublished"].includes(status) ? status : "published";
        if (book.adminLocked && newStatus === "published" && req.user.role !== "admin") {
          return res.status(403).json({
            error: "This book was unpublished by an admin. Status cannot be changed.",
            adminLocked: true,
          });
        }

        const updatedBook = {
          bookName:    bookName.trim(),
          authorName:  authorName.trim(),
          bookImage,
          description: description?.trim()  || "",
          category:    category?.trim()     || "",
          price:       Number(price),
          pages:       pages  ? Number(pages)  : 0,
          rating:      rating ? Number(rating) : 0,
          status:      newStatus,
          updatedAt:   new Date(),
        };

        await booksCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: updatedBook });
        res.json({ message: "Book updated successfully" });
      } catch (err) {
        console.error("PUT /books/:id error:", err);
        res.status(500).json({ error: "Failed to update book" });
      }
    });

    app.delete("/books/:id", verifyToken, async (req, res) => {
      try {
        const result = await booksCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        if (result.deletedCount === 0) return res.status(404).json({ error: "Book not found" });
        await ordersCollection.deleteMany({ bookId: req.params.id });
        res.json({ message: "Book deleted successfully" });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to delete book" });
      }
    });

    // ================= ORDER ROUTES =================
    app.get("/orders", verifyToken, async (req, res) => {
      try {
        const { email } = req.query;

        if (req.user.role === "admin" || req.user.role === "librarian") {
          const query = email ? { email } : {};
          const orders = await ordersCollection.find(query).sort({ orderDate: -1 }).toArray();
          return res.json(orders);
        }

        const orders = await ordersCollection
          .find({ email: req.user.email })
          .sort({ orderDate: -1 })
          .toArray();
        return res.json(orders);

      } catch (err) {
        console.error("Orders fetch error:", err);
        res.status(500).json({ error: "Failed to fetch orders" });
      }
    });

    app.post("/orders", verifyToken, async (req, res) => {
      const { bookId, bookName, bookImage, price, userName, email, phone, address } = req.body;

      if (!bookId || !bookName || !price || !email || !phone || !address) {
        return res.status(400).json({ error: "Missing required order fields" });
      }

      try {
        const newOrder = {
          bookId,
          bookName,
          bookImage: bookImage || "",
          price:     Number(price),
          userName:  userName || "Guest",
          email,
          phone,
          address,
          status:        "pending",
          paymentStatus: "unpaid",
          orderDate:     new Date(),
        };

        const result = await ordersCollection.insertOne(newOrder);
        res.status(201).json({ message: "Order placed successfully", orderId: result.insertedId });
      } catch (err) {
        console.error("Order creation error:", err);
        res.status(500).json({ error: "Failed to place order" });
      }
    });

    app.patch("/orders/:id/status", verifyToken, async (req, res) => {
      const { status } = req.body;
      if (!["pending", "shipped", "delivered", "cancelled"].includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      try {
        const result = await ordersCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { status } }
        );
        if (result.matchedCount === 0) return res.status(404).json({ error: "Order not found" });
        res.json({ message: "Order status updated" });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to update order" });
      }
    });

    // ================= WISHLIST ROUTES =================
    app.get("/wishlists/:email", verifyToken, async (req, res) => {
      try {
        const items = await wishlistsCollection
          .find({ email: req.params.email })
          .sort({ addedAt: -1 })
          .toArray();
        res.json(items);
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch wishlist" });
      }
    });

    app.post("/wishlists", verifyToken, async (req, res) => {
      // Frontend sends userId which contains the user's email
      const { userId, email, bookId, bookName, bookImage, price } = req.body;
      const userEmail = email || userId || req.user.email;

      if (!userEmail || !bookId) return res.status(400).json({ error: "Email (userId) and bookId required" });
      try {
        const existing = await wishlistsCollection.findOne({ email: userEmail, bookId });
        if (existing) return res.status(409).json({ error: "Book already in wishlist" });

        const item = { email: userEmail, bookId, bookName, bookImage, price, addedAt: new Date() };
        const result = await wishlistsCollection.insertOne(item);
        res.status(201).json({ message: "Added to wishlist", id: result.insertedId });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to add to wishlist" });
      }
    });

    app.delete("/wishlists/:id", verifyToken, async (req, res) => {
      try {
        const result = await wishlistsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        if (result.deletedCount === 0) return res.status(404).json({ error: "Wishlist item not found" });
        res.json({ message: "Removed from wishlist" });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to remove from wishlist" });
      }
    });

    // ================= REVIEW ROUTES =================
    app.get("/reviews/:bookId", async (req, res) => {
      try {
        const reviews = await reviewsCollection
          .find({ bookId: req.params.bookId })
          .sort({ createdAt: -1 })
          .toArray();
        res.json(reviews);
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch reviews" });
      }
    });

    app.post("/reviews", verifyToken, async (req, res) => {
      // Frontend sends userImage and date, backend was expecting userPhoto
      const { bookId, rating, comment, userName, userPhoto, userImage } = req.body;
      if (!bookId || !rating) return res.status(400).json({ error: "bookId and rating required" });
      if (rating < 1 || rating > 5) return res.status(400).json({ error: "Rating must be between 1 and 5" });

      try {
        // Check user has ordered this book
        const order = await ordersCollection.findOne({
          bookId,
          email: req.user.email,
          paymentStatus: "paid",
        });
        if (!order) {
          return res.status(403).json({ error: "You can only review books you have purchased." });
        }

        const photo = userImage || userPhoto || "";

        // One review per user per book
        const existing = await reviewsCollection.findOne({ bookId, email: req.user.email });
        if (existing) {
          // Update existing review
          await reviewsCollection.updateOne(
            { _id: existing._id },
            { $set: { rating: Number(rating), comment: comment?.trim() || "", date: new Date() } }
          );
          return res.json({ message: "Review updated", review: { ...existing, rating: Number(rating), comment: comment?.trim(), date: new Date() } });
        }

        const review = {
          bookId,
          email: req.user.email,
          userName: userName || req.user.name || "User",
          userImage: photo,
          rating: Number(rating),
          comment: comment?.trim() || "",
          date: new Date(),
        };

        const result = await reviewsCollection.insertOne(review);
        res.status(201).json({ message: "Review submitted", id: result.insertedId, review: { _id: result.insertedId, ...review } });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to submit review" });
      }
    });

    // ================= IMAGE UPLOAD =================
    app.post("/api/upload-image", async (req, res) => {
      const { image } = req.body;
      if (!image) return res.status(400).json({ error: "Image data required" });
      try {
        const form = new FormData();
        form.append("image", image);
        const response = await axios.post(
          `https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`,
          form,
          { headers: form.getHeaders() }
        );
        if (response.data.success) {
          res.json({ url: response.data.data.url });
        } else {
          res.status(500).json({ error: "ImgBB upload failed" });
        }
      } catch (err) {
        console.error("ImgBB upload error:", err.response?.data || err.message);
        res.status(500).json({ error: "Image upload failed" });
      }
    });

    // ================= START SERVER =================
    app.listen(port, () => {
      console.log(`Server running on http://localhost:${port}`);
    });

  } catch (err) {
    console.error("Server startup error:", err);
  }
}

run().catch(console.error);