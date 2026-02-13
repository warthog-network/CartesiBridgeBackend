# JavaScript DApp Template

This is a template for JavaScript Cartesi DApps. It uses node to execute the backend application.
The application entrypoint is the `src/index.js` file. It is bundled with [esbuild](https://esbuild.github.io), but any bundler can be used.

-docker should be runnig to test

##Test etherum wallet for local testing

-const ethers = require("ethers");
-const wallet = new ethers.Wallet("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
-console.log(wallet.address);  // → 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC

  ##Docker and cartesi steps and commands 
  
  #must register test wallet and relay dapp address before etherum withddraw
  
  cast send 0xF5DE34d6BbC0446E2a45719E718efEbaaE179daE "relayDAppAddress(address)" 0xab7528bb862fB57E8A2BCd567a2e929a0Be56a5e --rpc-url http://localhost:8545 --private-key 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a

#to ensure clean cache if changes are made local

docker builder prune -f &&
docker builder prune -a -f &&
docker builder prune &&
docker system prune -a --volumes -f &&
docker system prune -a -f --volumes &&
yarn cache clean --all &&     yarn install --network-timeout 600000 &&     yarn build &&
cartesi clean


# Recompile the Rust binary (takes ~10–60 seconds depending on Plonky3 deps)
cargo build --release --bin zk-proof-generator

# Optional: if you changed Cargo.toml or added crates
cargo update

cartesi build
cartesi run --epoch-length 1 --block-time 3



## Common Ethereum Function Selectors

This section provides a reusable list of common Keccak-256 function selectors for Ethereum smart contracts, including standard ERC interfaces and Cartesi-specific ones. These are useful for generating/validating vouchers, ABI interactions, or debugging calldata in your DApp.

### Usage
- See `selectors.js` for a JavaScript array export.
- To compute a new selector: Use Foundry's `cast sig "functionName(type1,type2)"` or online tools like 4byte.directory.
- Example in JS: Filter for a specific selector:
  ```javascript
  const selectors = require('./selectors.js');
  const withdrawSelector = selectors.find(s => s.signature === 'withdrawEther(address,uint256)').selector;
  console.log(withdrawSelector);  // Outputs: 0x522f6815
