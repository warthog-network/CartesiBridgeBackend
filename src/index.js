// dapp/src/index.js — FINAL LIQUID DApp (v1.5.0 + your features)
import { Wallet } from 'cartesi-wallet';
import { stringToHex, hexToString, getAddress } from 'viem';
import { ethers } from 'ethers';

const wallet = new Wallet();

// === YOUR TOKEN ADDRESSES (Sepolia) ===
const WWART_ADDRESS = "0xYourWWARTContractHere";  // ← Deploy wWART first!
const CTSI_ADDRESS = "0xae7f61eCf06C65405560166b259C54031428A9C4";
const USDC_ADDRESS = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

// === USER VAULTS — where all LIQUID magic happens ===
const userVaults = new Map(); // user → { liquid, wWART, CTSI, USDC }

// === PORTAL ADDRESSES (from tutorial) ===
const EtherPortal = "0xFfdbe43d4c855BF7e0f105c400A50857f53AB044";
const ERC20Portal = "0x4b088b2dee4d3c6ec7aa5fb4e6cd8e9f0a1b2c3d";  // ← ERC20Portal
const dAppAddressRelay = "0xF5DE34d6BbC0446E2a45719E718efEbaaE179daE";

let dAppAddress = "";

const rollupServer = process.env.ROLLUP_HTTP_SERVER_URL;
console.log("Rollup server URL:", rollupServer);

// Simple fetch wrappers
const postNotice = async (payload) => {
  await fetch(`${rollupServer}/notice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload })
  });
};

const postVoucher = async (voucher) => {
  await fetch(`${rollupServer}/voucher`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(voucher)
  });
};

const handleAdvance = async (data) => {
  console.log("Advance:", data);

  const sender = data.metadata.msg_sender.toLowerCase();
  const payload = data.payload;

  // 1. Relay dApp address (required for withdrawals)
  if (sender === dAppAddressRelay.toLowerCase()) {
    dAppAddress = payload;
    console.log("DApp address relayed:", dAppAddress);
    return "accept";
  }

  // 2. ERC20 Deposits (wWART, CTSI, USDC) — YOUR STEP 2
  if (sender === ERC20Portal.toLowerCase()) {
    const deposit = wallet.erc20_deposit_process(payload);
    const { erc20, amount, exec_layer_sender } = deposit;
    const token = erc20.toLowerCase();

    let vault = userVaults.get(exec_layer_sender);
    if (!vault) {
      vault = { liquid: 0n, wWART: 0n, CTSI: 0n, USDC: 0n };
      userVaults.set(exec_layer_sender, vault);
    }

    if (token === WWART_ADDRESS.toLowerCase()) vault.wWART += amount;
    else if (token === CTSI_ADDRESS.toLowerCase()) vault.CTSI += amount;
    else if (token === USDC_ADDRESS.toLowerCase()) vault.USDC += amount;

    await postNotice(stringToHex(JSON.stringify({ 
      type: "deposit", 
      user: exec_layer_sender, 
      token, 
      amount: amount.toString() 
    })));
    return "accept";
  }

  // 3. User operations — YOUR STEP 3 & 4
  if (data.payload) {
    let input;
    try { input = JSON.parse(hexToString(payload)); } catch { return "accept"; }

    // MINT LIQUID — STEP 3
    if (input.type === "mint_liquid") {
      const user = data.metadata.msg_sender;
      let vault = userVaults.get(user);
      if (!vault) {
        vault = { liquid: 0n, wWART: 0n, CTSI: 0n, USDC: 0n };
        userVaults.set(user, vault);
      }

      const total = vault.wWART + vault.CTSI + vault.USDC;
      if (total > 0n) {
        vault.liquid += total;
        userVaults.set(user, vault);

        await postNotice(stringToHex(JSON.stringify({ 
          type: "liquid_minted", 
          user, 
          amount: total.toString() 
        })));
      }
      return "accept";
    }

    // BURN LIQUID — STEP 4
    else if (input.type === "burn_liquid" && input.amount) {
      const user = data.metadata.msg_sender;
      const vault = userVaults.get(user);
      if (!vault || vault.liquid < BigInt(input.amount)) return "accept";

      vault.liquid -= BigInt(input.amount);
      userVaults.set(user, vault);

      await postNotice(stringToHex(JSON.stringify({ 
        type: "liquid_burned", 
        user, 
        amount: input.amount 
      })));
      return "accept";
    }
  }

  return "accept";
};

const main = async () => {
  let status = "accept";

  while (true) {
    const res = await fetch(`${rollupServer}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status })
    });

    if (res.status === 200) {
      const data = await res.json();
      if (data.request_type === "advance_state") {
        status = await handleAdvance(data.data);
      }
    }
  }
};

main().catch(err => {
  console.error("DApp crashed:", err);
  process.exit(1);
});