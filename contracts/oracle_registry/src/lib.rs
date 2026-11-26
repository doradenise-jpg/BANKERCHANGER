use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, Symbol, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleInfo {
    pub oracle: Address,
    pub added_at: u64,
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    NotAdmin = 1,
    OracleNotFound = 2,
    OracleAlreadyRemoved = 3,
    OracleAlreadyRegistered = 4,
}

const ADMIN: Symbol = Symbol::short("ADMIN");
const ORACLE_WHITELIST: Symbol = Symbol::short("WHITELIST");
const REMOVALS: Symbol = Symbol::short("REMOVALS");

#[contract]
pub struct OracleRegistry;

#[contractimpl]
impl OracleRegistry {
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&ADMIN) {
            panic!("already initialized");
        }
        env.storage().instance().set(&ADMIN, &admin);
        env.storage()
            .instance()
            .set(&ORACLE_WHITELIST, &Vec::<Address>::new(&env));
        env.storage()
            .instance()
            .set(&REMOVALS, &Vec::<Address>::new(&env));
    }

    pub fn add_oracle(env: Env, oracle: Address) -> Result<(), Error> {
        let admin: Address = env.storage().instance().get(&ADMIN).unwrap();
        admin.require_auth();

        let removals: Vec<Address> = env
            .storage()
            .instance()
            .get(&REMOVALS)
            .unwrap_or(Vec::new(&env));
        if removals.contains(&oracle) {
            return Err(Error::OracleAlreadyRemoved);
        }

        let mut whitelist: Vec<Address> = env
            .storage()
            .instance()
            .get(&ORACLE_WHITELIST)
            .unwrap_or(Vec::new(&env));
        if whitelist.contains(&oracle) {
            return Err(Error::OracleAlreadyRegistered);
        }
        whitelist.push_back(oracle.clone());
        env.storage().instance().set(&ORACLE_WHITELIST, &whitelist);
        Ok(())
    }

    pub fn remove_oracle(env: Env, oracle: Address) -> Result<(), Error> {
        let admin: Address = env.storage().instance().get(&ADMIN).unwrap();
        admin.require_auth();

        let mut whitelist: Vec<Address> = env
            .storage()
            .instance()
            .get(&ORACLE_WHITELIST)
            .unwrap_or(Vec::new(&env));

        let mut found: Option<u32> = None;
        for i in 0..whitelist.len() {
            if whitelist.get(i).unwrap() == oracle {
                found = Some(i);
                break;
            }
        }
        let index = match found {
            Some(i) => i,
            None => return Err(Error::OracleNotFound),
        };
        whitelist.remove(index);
        env.storage().instance().set(&ORACLE_WHITELIST, &whitelist);

        let mut removals: Vec<Address> = env
            .storage()
            .instance()
            .get(&REMOVALS)
            .unwrap_or(Vec::new(&env));
        if !removals.contains(&oracle) {
            removals.push_back(oracle.clone());
            env.storage().instance().set(&REMOVALS, &removals);
        }

        env.events().publish(
            (Symbol::short("OracleRemoved"), oracle.clone()),
            Symbol::short("admin_removal"),
        );
        Ok(())
    }

    pub fn is_oracle(env: Env, oracle: Address) -> bool {
        let whitelist: Vec<Address> = env
            .storage()
            .instance()
            .get(&ORACLE_WHITELIST)
            .unwrap_or(Vec::new(&env));
        whitelist.contains(&oracle)
    }

    pub fn is_removed(env: Env, oracle: Address) -> bool {
        let removals: Vec<Address> = env
            .storage()
            .instance()
            .get(&REMOVALS)
            .unwrap_or(Vec::new(&env));
        removals.contains(&oracle)
    }
}
