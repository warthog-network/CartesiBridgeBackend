// index.js
console.log("MERGED WITHDRAWAL CODE 1234.5 zk generator called from javasript sub_unlock - JAN 2026: Original ETH deposit/withdraw preserved + subwallet test lock/unlock added + PDAI replaced with USDC (Sepolia)+spoofed wwart tracking w correct spoof fetch"); // Updated tag for USDC switch

const ethers = require("ethers");
const { Wallet } = require("cartesi-wallet");
const { stringToHex, hexToString } = require("viem");
const { parseEther } = require("ethers");
const wallet = new Wallet(); // Keep original instantiation (no balances Map needed unless required; tested compatible)

// === TOKEN ADDRESSES (Sepolia example — change if needed) ===
const WWART_ADDRESS = "0xYourWWARTContractHere"; // Replace or leave as-is if not used yet
const CTSI_ADDRESS = "0xae7f61eCf06C65405560166b259C54031428A9C4";
const USDC_ADDRESS = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"; // Real Sepolia USDC (6 decimals)

// === PORTAL ADDRESSES (Sepolia) ===
const EtherPortal = "0xFfdbe43d4c855BF7e0f105c400A50857f53AB044";
const ERC20Portal = "0x4b088b2dee4d3c6ec7aa5fb4e6cd8e9f0a1b2c3d";
const dAppAddressRelay = "0xF5DE34d6BbC0446E2a45719E718efEbaaE179daE";

// === GLOBAL STATE ===
const userVaults = new Map();           // address → vault object
let registeredUsers = new Map();        // address → true
let dAppAddress = "";
let subLocks = new Map(); // NEW: subAddress → {locked: boolean, owner: string, proof: any, minted: bigint} for test lock/unlock
const userMintHistories = new Map(); // user (owner) => array of {amount: bigint, subAddress: string, timestamp: number, txHash: string}
const userBurnHistories = new Map(); // user (owner) => array of {amount: bigint, subAddress: string, timestamp: number}

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

  // 3. ETH DEPOSITS — Use manual parsing for proper depositor extraction
  if (sender === EtherPortal.toLowerCase()) {
    console.log("ETH PORTAL INPUT RECEIVED - PAYLOAD:", request.payload);

    let amountWei = 0n;
    let depositor = "";

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

    if (amountWei === 0n || depositor === "0x0000000000000000000000000000000000000000") {
      console.log("Invalid amount or depositor — ignoring");
      return "accept";
    }

    console.log(`Crediting ${formatEther(amountWei)} ETH to ${depositor}`);

    let vault = userVaults.get(depositor) || {
      liquid: 0n,
      wWART: 0n,
      CTSI: 0n,
      usdc: 0n,
      eth: 0n,
      spoofedMinted: 0n,
      spoofedBurned: 0n
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

      let vault = userVaults.get(user) || { 
        liquid: 0n, 
        wWART: 0n, 
        CTSI: 0n, 
        usdc: 0n, 
        eth: 0n,
        spoofedMinted: 0n,
        spoofedBurned: 0n
      };

      if (token === WWART_ADDRESS.toLowerCase()) vault.wWART += amount;
      else if (token === CTSI_ADDRESS.toLowerCase()) vault.CTSI += amount;
      else if (token === USDC_ADDRESS.toLowerCase()) vault.usdc += amount;

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

    let vault = userVaults.get(user) || { 
      liquid: 0n, 
      wWART: 0n, 
      CTSI: 0n, 
      usdc: 0n, 
      eth: 0n,
      spoofedMinted: 0n,
      spoofedBurned: 0n
    };
    const totalBacking = vault.wWART + vault.CTSI + vault.usdc + vault.eth;

    if (totalBacking > 0n) {
      vault.liquid += totalBacking;
      vault.wWART = 0n;
      vault.CTSI = 0n;
      vault.usdc = 0n;
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
  
  // Helper: Left-pad a hex string (without '0x') to a fixed length with zeros
  const leftPadHex = (hexStr, length) => {
    return hexStr.padStart(length, '0');
  };

  // 7. WITHDRAW ETH — Fully manual voucher encoding (no libraries)
  if (input?.type === "withdraw_eth" && input.amount) {
    const user = request.metadata.msg_sender.toLowerCase();

    if (!dAppAddress) {
      console.log("dApp address not relayed yet, cannot withdraw");
      return "reject";
    }

    let amountWei;
    try {
      // Manual parseEther equivalent: Handle decimal string to BigInt wei
      const parts = input.amount.split('.');
      if (parts.length > 2) throw new Error("Invalid amount");
      let integerPart = BigInt(parts[0] || 0);
      let fractionalPart = parts[1] ? BigInt(parts[1].padEnd(18, '0').slice(0, 18)) : 0n;
      amountWei = integerPart * 1000000000000000000n + fractionalPart;
      if (amountWei <= 0n) throw new Error("Amount must be positive");
    } catch (e) {
      console.error("Invalid ETH amount format:", e);
      return "reject";
    }

    const amountBig = amountWei;

    const vault = userVaults.get(user);
    if (!vault || vault.eth < amountBig) {
      console.log("Insufficient ETH balance for withdrawal");
      return "reject";
    }

    console.log(`Processing withdrawal of ${formatEther(amountBig)} ETH for ${user}`);
    console.log("Vault ETH balance before withdrawal:", formatEther(vault.eth));
    // Deduct from vault
    vault.eth -= amountBig;
    userVaults.set(user, vault);

    console.log("Vault ETH balance after deduction:", formatEther(vault.eth));

    // Manual ABI encoding for withdrawEther(address,uint256)
    const withdrawEtherSelector = "0x522f6815";
    const userHex = user.slice(2); // Remove '0x'
    const paddedUser = leftPadHex(userHex, 64); // Pad to 32 bytes (64 hex)
    const amountHex = amountWei.toString(16);
    const paddedAmount = leftPadHex(amountHex, 64); // Pad to 32 bytes (64 hex)

    const payloadWithout0x = withdrawEtherSelector.slice(2) + paddedUser + paddedAmount; // Concat (remove selector's '0x')
    const payload = "0x" + payloadWithout0x;

    // Voucher with correct fields only
    const voucher = {
      destination: dAppAddress,
      payload: payload
    };

    // Emit the voucher
    try {
      const response = await fetch(`${rollupServer}/voucher`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(voucher),
      });

      if (!response.ok) {
        // Revert state on failure
        vault.eth += amountBig;
        userVaults.set(user, vault);
        console.error("Voucher emission failed with status:", response.status);
        return "reject";
      }

      console.log(`Voucher emitted successfully for ${formatEther(amountBig)} ETH to ${user}`);
    } catch (e) {
      // Revert on error
      vault.eth += amountBig;
      userVaults.set(user, vault);
      console.error("Error emitting voucher:", e);
      return "reject";
    }

    // Send notice
    await sendNotice(stringToHex(JSON.stringify({
      type: "eth_withdrawn",
      user,
      amount: formatEther(amountBig)
    })));

    console.log(`*** ETH WITHDRAWAL PROCESSED: ${formatEther(amountBig)} ETH → ${user} ***`);
    return "accept";
  }

  // NEW: MERGED sub_lock (for proof-based or condition-based lock; unified from "lock_subwallet")
  if (input?.type === "sub_lock") {
    const subAddress = input.subAddress;
    const proof = input.proof; // Optional for condition-based
    const condition = input.condition || "true"; // Optional, for test/merged
    const subLock = subLocks.get(subAddress) || { locked: false, owner: input.recipient, proof: null, minted: 0n };
    if (!subLock.locked) {
      // Validate: Use proof if present, else condition (for merged test logic)
      const isValid = proof ? (proof.transaction && proof.transaction.toAddress.toLowerCase() === subAddress.toLowerCase()) : (condition === "true"); // Add real proof validation if needed
      if (isValid) {
        subLock.locked = true;
        subLock.proof = proof || null;
        // Extract mint details from proof (keep in E8 as bigint)
        const mintAmountE8 = proof?.transaction?.amountE8 ? BigInt(proof.transaction.amountE8) : 0n; // Use amountE8
        subLock.minted = mintAmountE8; // Now store as E8
        const txHash = proof?.transaction?.txHash || ''; // Use txHash (from logs)
        const owner = input.recipient.toLowerCase();
        const history = userMintHistories.get(owner) || [];
        history.push({ amount: mintAmountE8, subAddress, timestamp: Date.now(), txHash });
        userMintHistories.set(owner, history);

        const vault = userVaults.get(owner) || {
          liquid: 0n,
          wWART: 0n,
          CTSI: 0n,
          usdc: 0n,
          eth: 0n,
          spoofedMinted: 0n,
          spoofedBurned: 0n
        };
        vault.spoofedMinted += mintAmountE8;
        userVaults.set(owner, vault);

        subLocks.set(subAddress, subLock);
        await sendNotice(stringToHex(JSON.stringify({ type: "subwallet_locked", subAddress, verified: true })));
        console.log(`Subwallet ${subAddress} locked with proof/condition and spoofed mint recorded: ${mintAmountE8} E8 wWART for ${owner}`);
      } else {
        await sendNotice(stringToHex(JSON.stringify({ type: "lock_failed", subAddress, verified: false })));
        console.log(`Lock failed for ${subAddress} (invalid)`);
      }
    } else {
      await sendNotice(stringToHex(JSON.stringify({ type: "lock_failed", subAddress, verified: false })));
      console.log(`Lock failed for ${subAddress} (already locked)`);
    }
    const { spawn } = require('child_process');

    console.log("[ZK TEST] Spawning zk-proof-generator...");

    const proofProcess = spawn('/opt/cartesi/bin/zk-proof-generator', [
      '--sub-address', subAddress,
      '--amount', '1000000000',  // test value (1 WART in e8)
      '--timestamp', Date.now().toString(),
      '--input-index', (request.metadata.input_index || 0).toString()
    ]);

    proofProcess.stdout.on('data', (data) => {
      const output = data.toString().trim();
      console.log('[ZK OUT]', output);

      // Emit a test notice so frontend can see it worked
      sendNotice(stringToHex(JSON.stringify({
        type: "zk_proof_test",
        message: "Rust zk-proof-generator called successfully",
        rust_output: output,
        subAddress: subAddress
      })));
    });

    proofProcess.stderr.on('data', (data) => {
      console.error('[ZK ERROR]', data.toString());
    });

    proofProcess.on('close', (code) => {
      console.log(`[ZK] zk-proof-generator exited with code ${code}`);
    });
    return "accept";
  }

  // NEW: MERGED sub_unlock (for proof-based or condition-based unlock; unified from "unlock_subwallet")
  if (input?.type === "sub_unlock") {
    const subAddress = input.subAddress?.toLowerCase() ?? "";

    if (!subAddress) {
        await sendNotice(stringToHex(JSON.stringify({
            type: "subwallet_unlock_response",
            success: false,
            reason: "missing_address"
        })));
        return "accept";
    }

    const subLock = subLocks.get(subAddress);

    if (!subLock?.locked) {
        await sendNotice(stringToHex(JSON.stringify({
            type: "subwallet_unlock_response",
            subAddress,
            success: false,
            reason: subLock ? "already_unlocked" : "not_found"
        })));
        return "accept";
    }

    // Perform unlock
    const burnedAmount = subLock.minted || 0n;
    subLock.locked = false;
    subLock.minted = 0n;
    subLocks.set(subAddress, subLock);

    // Optional: update tracking
    if (subLock.owner) {
        const owner = subLock.owner.toLowerCase();
        const vault = userVaults.get(owner);
        if (vault) {
            vault.spoofedBurned += burnedAmount;
            userVaults.set(owner, vault);
        }

        const history = userBurnHistories.get(owner) || [];
        history.push({
            amount: burnedAmount,
            subAddress,
            timestamp: Date.now()
        });
        userBurnHistories.set(owner, history);
    }

    // Success notice - this is all the frontend needs
    await sendNotice(stringToHex(JSON.stringify({
        type: "subwallet_unlocked",
        subAddress,
        verified: true,
        burnedE8: burnedAmount.toString(),
        timestamp: Date.now(),
        message: "Sub-wallet unlocked - you can now withdraw using your private key"
    })));

    console.log(`[sub_unlock] SUCCESS: ${subAddress} unlocked (${burnedAmount} tracked)`);

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
      usdc: 0n,
      eth: 0n,
      spoofedMinted: 0n,
      spoofedBurned: 0n
    };

    const mintHistory = userMintHistories.get(address) || [];
    const burnHistory = userBurnHistories.get(address) || [];
    const totalSpoofedMintedE8 = mintHistory.reduce((sum, m) => sum + m.amount, 0n);
    const totalSpoofedBurnedE8 = burnHistory.reduce((sum, b) => sum + b.amount, 0n);

    const reportPayload = stringToHex(JSON.stringify({
      liquid: vault.liquid.toString(),
      wWART: vault.wWART.toString(),
      CTSI: vault.CTSI.toString(),
      usdc: vault.usdc.toString(),
      eth: formatEther(vault.eth),
      spoofedMintHistory: mintHistory.map(m => ({...m, amount: m.amount.toString()})),
      spoofedBurnHistory: burnHistory.map(b => ({...b, amount: b.amount.toString()})),
      totalSpoofedMinted: totalSpoofedMintedE8.toString(),
      totalSpoofedBurned: totalSpoofedBurnedE8.toString()
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