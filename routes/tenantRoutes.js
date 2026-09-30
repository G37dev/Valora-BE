const express = require("express");
const router = express.Router();
const tenantController = require("../controllers/tenantController");
const { verifyTenantApiKey } = require("../middlewares/tenantAuth");

router.post("/", tenantController.createTenant);
router.get("/", tenantController.getTenants);
router.post(
  "/link-customer",
  verifyTenantApiKey,
  tenantController.registerOrLinkCustomer,
);

module.exports = router;
