require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const axios = require("axios");
const FormData = require("form-data");

const app = express();
const port = process.env.PORT || 5020;

/* ================= STRIPE WEBHOOK (MUST BE FIRST) ================= */
let ordersCollection;

app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Webhook error:", err.message);
      return res.status(400).send("Webhook Error");
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const orderId = session.metadata?.orderId;

      if (orderId) {
        await ordersCollection.updateOne(
          { _id: new ObjectId(orderId) },
          {
            $set: {
              paymentStatus: "paid",
              status: "completed",
              paidAt: new Date(),
            },
          }
        );
        console.log("✅ Order marked PAID:", orderId);
      }
    }

    res.json({ received: true });
  }
);

/* ================= MIDDLEWARE ================= */
app.use(cors());
app.use(express.json({ limit: "10mb" }));

/* ================= MONGODB ================= */
const client = new MongoClient(process.env.MONGO_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let booksCollection;
let usersCollection;
let librarianRequestsCollection;

async function run() {
  await client.connect();
  console.log("✅ MongoDB connected");

  const db = client.db("bookcourier");
  booksCollection = db.collection("books");
  ordersCollection = db.collection("orders");
  usersCollection = db.collection("users");
  librarianRequestsCollection = db.collection("librarianRequests");

  /* ================= ROOT ================= */
  app.get("/", (req, res) => {
    res.send("BookCourier API running 🚀");u
  });

  /* ================= BOOKS ================= */
  app.get("/books", async (req, res) => {
    res.json(await booksCollection.find().toArray());
  });

  app.get("/books/:id", async (req, res) => {
    try {
      const book = await booksCollection.findOne({
        _id: new ObjectId(req.params.id),
      });
      if (!book) return res.status(404).json({ error: "Book not found" });
      res.json(book);
    } catch {
      res.status(400).json({ error: "Invalid book ID" });
    }
  });

  /* ================= ORDERS ================= */
  app.get("/orders", async (req, res) => {
    const query = req.query.email ? { email: req.query.email } : {};
    res.json(
      await ordersCollection.find(query).sort({ orderDate: -1 }).toArray()
    );
  });

  app.post("/orders", async (req, res) => {
    const { bookId, bookName, price, userName, email, phone, address } =
      req.body;

    if (!bookName || !email || price == null) {
      return res.status(400).json({ error: "Missing order data" });
    }

    const order = {
      bookId,
      bookName,
      price: Number(price),
      userName,
      email,
      phone,
      address,
      orderDate: new Date(),
      status: "pending",
      paymentStatus: "unpaid",
    };

    const result = await ordersCollection.insertOne(order);
    res.json({ orderId: result.insertedId });
  });

  app.patch("/orders/:id/cancel", async (req, res) => {
    const result = await ordersCollection.updateOne(
      { _id: new ObjectId(req.params.id), paymentStatus: "unpaid" },
      { $set: { status: "cancelled" } }
    );

    if (!result.matchedCount) {
      return res
        .status(400)
        .json({ error: "Order already paid or not found" });
    }

    res.json({ message: "Order cancelled" });
  });

  /* ================= STRIPE ================= */
  app.post("/create-checkout-session", async (req, res) => {
    const { orderId, bookName, price } = req.body;

    if (!orderId || !bookName || price == null) {
      return res.status(400).json({ error: "Missing checkout data" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: bookName },
            unit_amount: Math.round(price * 100),
          },
          quantity: 1,
        },
      ],
      success_url: "http://localhost:5173/my-orders?payment=success",
      cancel_url: "http://localhost:5173/my-orders?payment=cancelled",
      metadata: { orderId: orderId.toString() },
    });

    res.json({ url: session.url });
  });

  /* ================= USERS ================= */

  // Create / sync user
  app.post("/api/user", async (req, res) => {
    const { email, displayName, uid } = req.body;

    let user = await usersCollection.findOne({ email });
    if (!user) {
      const newUser = {
        uid,
        email,
        displayName: displayName || "User",
        role: "user",
        createdAt: new Date(),
      };
      const result = await usersCollection.insertOne(newUser);
      user = { _id: result.insertedId, ...newUser };
    }

    res.json({
      _id: user._id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    });
  });

  // 🔥 GET ALL USERS (ADMIN DASHBOARD)
  app.get("/api/users", async (req, res) => {
    res.json(await usersCollection.find().toArray());
  });

  // 🔥 UPDATE USER ROLE
  app.patch("/api/users/:id/role", async (req, res) => {
    const { role } = req.body;

    if (!["admin", "librarian", "user"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    const result = await usersCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { role } }
    );

    if (!result.matchedCount) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ message: "Role updated" });
  });

  /* ================= BECOME LIBRARIAN ================= */
  // Become Librarian Request
app.post("/api/users/become-librarian", async (req, res) => {
  const { userId } = req.body;

  if (!userId) return res.status(400).json({ error: "User ID required" });

  try {
    // Check if a request already exists
    const existingRequest = await client
      .db("bookcourier")
      .collection("librarianRequests")
      .findOne({ userId });

    if (existingRequest) {
      return res.status(400).json({ error: "Request already submitted" });
    }

    const user = await usersCollection.findOne({ uid: userId });
    if (!user) return res.status(404).json({ error: "User not found" });

    const request = {
      userId,
      userInfo: {
        email: user.email,
        displayName: user.displayName,
      },
      status: "pending",
      requestedAt: new Date(),
    };

    const result = await client
      .db("bookcourier")
      .collection("librarianRequests")
      .insertOne(request);

    res.json({ success: true, requestId: result.insertedId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Get all requests (Admin Dashboard)
app.get("/api/librarian-requests", async (req, res) => {
  try {
    const requests = await client
      .db("bookcourier")
      .collection("librarianRequests")
      .find()
      .toArray();
    res.json(requests);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Approve/Reject request (Admin)
app.patch("/api/librarian-requests/:id", async (req, res) => {
  const { status } = req.body; // "approved" or "rejected"

  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  try {
    const requestId = req.params.id;
    const requestCollection = client.db("bookcourier").collection("librarianRequests");
    const request = await requestCollection.findOne({ _id: new ObjectId(requestId) });

    if (!request) return res.status(404).json({ error: "Request not found" });

    // Update request status
    await requestCollection.updateOne(
      { _id: new ObjectId(requestId) },
      { $set: { status } }
    );

    // If approved, update user role
    if (status === "approved") {
      await usersCollection.updateOne(
        { uid: request.userId },
        { $set: { role: "librarian" } }
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

  /* ================= IMGBB ================= */
  app.post("/api/upload-image", async (req, res) => {
    try {
      const { image } = req.body;
      if (!image) return res.status(400).json({ error: "Image required" });

      const formData = new FormData();
      formData.append("image", image);

      const response = await axios.post(
        `https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`,
        formData,
        { headers: formData.getHeaders() }
      );

      res.json({ url: response.data.data.url });
    } catch (err) {
      console.error("ImgBB error:", err.message);
      res.status(500).json({ error: "Image upload failed" });
    }
  });

  /* ================= START ================= */
  app.listen(port, () => {
    console.log(`🚀 Server running on http://localhost:${port}`);
  });
}

run().catch(console.error);