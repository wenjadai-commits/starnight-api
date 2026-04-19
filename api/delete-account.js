const admin = require('firebase-admin');

function getAdminApp() {
  if (admin.apps.length) return admin.app();

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Missing Firebase Admin environment variables.');
  }

  return admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, '\n'),
    }),
  });
}

async function deleteDocumentTree(docRef) {
  const collections = await docRef.listCollections();
  for (const collection of collections) {
    await deleteCollectionTree(collection);
  }
  await docRef.delete().catch(() => {});
}

async function deleteCollectionTree(collectionRef) {
  const snapshot = await collectionRef.get();
  for (const doc of snapshot.docs) {
    await deleteDocumentTree(doc.ref);
  }
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const app = getAdminApp();
    const token = getBearerToken(req);

    if (!token) {
      return res.status(401).json({ error: 'Missing Firebase ID token.' });
    }

    const decoded = await admin.auth(app).verifyIdToken(token);
    const uid = decoded.uid;
    const db = admin.firestore(app);

    await deleteDocumentTree(db.collection('users').doc(uid));
    await admin.auth(app).deleteUser(uid);

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('delete-account error:', error);

    if (error && error.code === 'auth/id-token-expired') {
      return res.status(401).json({ error: 'Firebase ID token expired.' });
    }

    if (error && error.code === 'auth/argument-error') {
      return res.status(401).json({ error: 'Invalid Firebase ID token.' });
    }

    return res.status(500).json({ error: 'Failed to delete account.' });
  }
};
