// dapp/src/index.js — UPDATED FOR PDAI + ETH DEPOSIT FIX WITH ETHER LIBRARY PROCESSING
const ethers = require("ethers");
const { Wallet } = require("cartesi-wallet");
const { stringToHex, hexToString } = require("viem");

const wallet = new Wallet();

// === TOKEN ADDRESSES (Sepolia example — change if needed) ===
const WWART_ADDRESS = "0xYourWWARTContractHere"; // Replace or leave as-is if not used yet
const CTSI_ADDRESS = "0xae7f61eCf06C65405560166b259C54031428A9C4";
const PDAI_ADDRESS = "0xYourPDAIContractHere"; // Placeholder for PDAI (replace with actual address; assumes 6 decimals)

// === PORTAL ADDRESSES (Sepolia) ===
const EtherPortal = "0xFfdbe43d4c855BF7e0f105c400A50857f53AB044";
const ERC20Portal = "0x4b088b2dee4d3c6ec7aa5fb4e6cd8e9f0a1b2c3d";
const dAppAddressRelay = "0xF5DE34d6BbC0446E2a45719E718efEbaaE179daE";

// === GLOBAL STATE ===
const userVaults = new Map();           // address → vault object
let registeredUsers = new Map();        // address → true
let dAppAddress = "";

const rollupServer = process.env.ROLLUP_HTTP_SERVER_URL;
console.log("HTTP rollup_server url:", rollupServer);

// Helper: send a notice
const sendNotice = async (payload) => {
  try {
    await fetch(`${rollupServer}/notice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload }),
    });
  } catch (e) {
    console.error("Notice failed:", e);
  }
};

// Helper: send a report (used in inspect)
const sendReport = async (payload) => {
  try {
    await fetch(`${rollupServer}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload }),
    });
  } catch (e) {
    console.error("Report failed:", e);
  }
};

const formatEther = (wei) => {
  if (wei === 0n) return "0.0";
  const str = wei.toString();
  const integerPart = str.length > 18 ? str.slice(0, str.length - 18) : "0";
  let fractionalPart = str.length > 18 ? str.slice(str.length - 18) : "0".repeat(18 - str.length) + str;
  fractionalPart = fractionalPart.replace(/0+$/, "");  // Remove trailing zeros
  return fractionalPart ? `${integerPart}.${fractionalPart}` : integerPart;
};

// === ADVANCE STATE HANDLER ===
const handleAdvance = async (request) => {
  const payload = request.payload;
  const sender = request.metadata.msg_sender.toLowerCase();

  let input = null;
  if (payload && payload.startsWith("0x")) {
    try {
      const decoded = hexToString(payload);
      input = JSON.parse(decoded);
      console.log("Parsed input:", input);
    } catch (e) {
      console.log("Payload is not JSON (probably a portal deposit)");
    }
  }

  // 1. DApp Address Relay
  if (sender === dAppAddressRelay.toLowerCase()) {
    dAppAddress = payload;
    console.log("DApp address relayed:", dAppAddress);
    return "accept";
  }

  // 2. USER REGISTERS THEIR ADDRESS
  if (input?.type === "register_address") {
    const user = request.metadata.msg_sender.toLowerCase();
    registeredUsers.set(user, true);

    await sendNotice(stringToHex(JSON.stringify({ type: "address_registered", user })));
    console.log("Received register_address from", user);
    return "accept";
  }

// 3. ETH DEPOSITS — Use manual parsing for proper depositor extraction (fixes library/version issues and unpadded payload)
if (sender === EtherPortal.toLowerCase()) {
  console.log("ETH PORTAL INPUT RECEIVED - PAYLOAD:", request.payload);

  let amountWei = 0n;
  let depositor = "";

  if (request.payload && request.payload.startsWith("0x") && request.payload.length === 106) {  // 0x + 40 hex (address) + 64 hex (amount)
    try {
      const data = request.payload.slice(2);  // Remove '0x'
      depositor = "0x" + data.slice(0, 40).toLowerCase();
      const amountHex = "0x" + data.slice(40);
      amountWei = BigInt(amountHex);

      console.log("Parsed depositor from payload:", depositor);
      console.log("Parsed amount from payload:", amountWei.toString());
    } catch (e) {
      console.error("ETH payload parsing error:", e);
      return "reject";  // Reject on parse failure to maintain trustless integrity
    }
  }

  if (amountWei === 0n || depositor === "0x0000000000000000000000000000000000000000") {
    console.log("Invalid amount or depositor — ignoring");
    return "accept";
  }

  console.log(`Crediting ${formatEther(amountWei)} ETH to ${depositor}`);

  let vault = userVaults.get(depositor) || {
    liquid: 0n,
    wWART: 0n,
    CTSI: 0n,
    pdai: 0n,
    eth: 0n
  };

  vault.eth += amountWei;
  userVaults.set(depositor, vault);

  await sendNotice(stringToHex(JSON.stringify({
    type: "eth_deposit",
    user: depositor,
    amount: formatEther(amountWei)
  })));

  console.log(`*** ETH DEPOSIT CREDITED: ${formatEther(amountWei)} ETH → ${depositor} ***`);

  return "accept";
}


  // 4. ERC20 DEPOSITS — Use exec_layer_sender directly
  if (sender === ERC20Portal.toLowerCase()) {
    try {
      const deposit = wallet.erc20_deposit_process(payload);
      const { erc20, amount, exec_layer_sender } = deposit;
      const token = erc20.toLowerCase();
      const user = exec_layer_sender.toLowerCase();

      let vault = userVaults.get(user) || { liquid: 0n, wWART: 0n, CTSI: 0n, pdai: 0n, eth: 0n };

      if (token === WWART_ADDRESS.toLowerCase()) vault.wWART += amount;
      else if (token === CTSI_ADDRESS.toLowerCase()) vault.CTSI += amount;
      else if (token === PDAI_ADDRESS.toLowerCase()) vault.pdai += amount;

      userVaults.set(user, vault);

      await sendNotice(stringToHex(JSON.stringify({ type: "erc20_deposit", user, token: erc20, amount: amount.toString() })));
      console.log(`ERC20 deposit: ${amount} of ${erc20} → ${user}`);
    } catch (e) {
      console.error("ERC20 deposit parsing failed:", e);
    }
    return "accept";
  }
  // 5. MINT LIQUID
  if (input?.type === "mint_liquid") {
    const user = request.metadata.msg_sender.toLowerCase();

    if (!registeredUsers.has(user)) {
      console.log("User not registered, ignoring mint");
      return "reject";
    }

    let vault = userVaults.get(user) || { liquid: 0n, wWART: 0n, CTSI: 0n, pdai: 0n, eth: 0n };
    const totalBacking = vault.wWART + vault.CTSI + vault.pdai + vault.eth;

    if (totalBacking > 0n) {
      vault.liquid += totalBacking;
      vault.wWART = 0n;
      vault.CTSI = 0n;
      vault.pdai = 0n;
      vault.eth = 0n;

      userVaults.set(user, vault);

      await sendNotice(stringToHex(JSON.stringify({
        type: "liquid_minted",
        user,
        amount: totalBacking.toString()
      })));
      console.log(`Minted ${totalBacking} LIQUID for ${user}`);
    }
    return "accept";
  }

  // 6. BURN LIQUID
  if (input?.type === "burn_liquid" && input.amount) {
    const user = request.metadata.msg_sender.toLowerCase();
    const amount = BigInt(input.amount);

    const vault = userVaults.get(user);
    if (!vault || vault.liquid < amount) {
      return "reject";
    }

    vault.liquid -= amount;
    userVaults.set(user, vault);

    await sendNotice(stringToHex(JSON.stringify({
      type: "liquid_burned",
      user,
      amount: input.amount
    })));
    console.log(`Burned ${input.amount} LIQUID for ${user}`);
    return "accept";
  }

  return "accept";
};

// === INSPECT HANDLER ===

const handleInspect = async (rawPayload) => {
  console.log("INSPECT REQUEST - RAW PAYLOAD:", rawPayload || "NO PAYLOAD");

  // === STEP 1: Decode the hex payload to UTF-8 string ===
  let path = "";
  if (typeof rawPayload === "string" && rawPayload.startsWith("0x")) {
    try {
      path = Buffer.from(rawPayload.slice(2), "hex").toString("utf-8");
      console.log("SUCCESSFULLY DECODED PATH:", path);
    } catch (e) {
      console.log("FAILED TO DECODE HEX PAYLOAD:", e.message);
      return "accept";
    }
  } else if (typeof rawPayload === "string") {
    path = rawPayload; // fallback (shouldn't happen now)
    console.log("PATH WAS ALREADY STRING (unusual):", path);
  } else {
    console.log("UNEXPECTED PAYLOAD TYPE:", typeof rawPayload);
    return "accept";
  }

  // === STEP 2: Now work with the decoded path ===
  if (path.toLowerCase().includes("vault")) {
    console.log("VAULT INSPECT DETECTED - DECODED PATH:", path);

    let address = path.toLowerCase().replace(/^\/+/, ''); // remove leading slashes

    // Extract address after "vault/"
    if (address.startsWith("vault/")) {
      address = address.slice(6);
    } else if (address.startsWith("vault")) {
      address = address.slice(5);
    }

    // Add 0x if missing
    if (!address.startsWith("0x")) {
      address = "0x" + address;
    }

    // Validate address
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      console.log("INVALID ADDRESS EXTRACTED:", address);
      await sendReport(stringToHex(JSON.stringify({ error: "Invalid Ethereum address" })));
      return "accept";
    }

    console.log("QUERYING VAULT FOR ADDRESS:", address);

    const vault = userVaults.get(address) || {
      liquid: 0n,
      wWART: 0n,
      CTSI: 0n,
      pdai: 0n,
      eth: 0n
    };

    const reportPayload = stringToHex(JSON.stringify({
      liquid: vault.liquid.toString(),
      wWART: vault.wWART.toString(),
      CTSI: vault.CTSI.toString(),
      pdai: vault.pdai.toString(),
      eth: formatEther(vault.eth),  // ← Clean formatted ETH (e.g., "0.0", "1.5", "0.000123")
    }));
    await sendReport(reportPayload);
    console.log("VAULT REPORT SENT FOR:", address);
    console.log("ETH balance in vault:", formatEther(vault.eth));

  } else {
    console.log("Non-vault inspect path - ignored:", path);
  }

  return "accept";
};
// === MAIN LOOP ===
async function main() {
  let status = "accept";

  while (true) {
    const finishRes = await fetch(`${rollupServer}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });

    if (finishRes.status === 200) {
      const data = await finishRes.json();

      if (data.request_type === "advance_state") {
        status = await handleAdvance(data.data);
      } else if (data.request_type === "inspect_state") {
        let inspectPath = null;

        if (data.data && typeof data.data === "object") {
          if (data.data.path !== undefined) {
            inspectPath = data.data.path;
          } else if (data.data.payload !== undefined) {
            inspectPath = data.data.payload;
          } else {
            inspectPath = JSON.stringify(data.data);
          }
        } else if (data.data) {
          inspectPath = data.data;
        }

        console.log("INSPECT REQUEST - Extracted path:", inspectPath);
        status = await handleInspect(inspectPath);
      }
    } else {
      console.error("Finish error:", finishRes.status);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

main().catch((err) => {
  console.error("DApp crashed:", err);
  process.exit(1);
});