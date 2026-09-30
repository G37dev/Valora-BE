const jwt = require("jsonwebtoken");

const verifyToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];

  // Format header biasanya: "Bearer <token>"
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Akses ditolak. Token tidak ditemukan.",
    });
  }

  jwt.verify(
    token,
    process.env.JWT_SECRET || "Valoracore77!",
    (err, decodedUser) => {
      if (err) {
        return res.status(403).json({
          success: false,
          message: "Token tidak valid atau sudah kedaluwarsa.",
        });
      }

      req.user = decodedUser;
      next();
    },
  );
};

module.exports = { verifyToken };
